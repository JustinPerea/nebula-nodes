/**
 * Where `type` shows its caret or underline (GM - Design's cursor spec, §2):
 * the target card's free-text field, with the caret at the end of its text;
 * or, for a param edit at a port, the row's label, underlined. Only read when
 * a type state starts and when the field's text changes, never per frame.
 * Positions are in the card's own px (flow units), from the node's corner,
 * so a moved node carries them and a zoom scales them like the text.
 */
export type TypeField =
  | { kind: 'text'; el: HTMLTextAreaElement | HTMLInputElement }
  | { kind: 'param'; label: string; el: HTMLElement };

/** The mark's box from the node's corner, in flow units. */
export interface FieldBox {
  kind: 'caret' | 'underline';
  x: number;
  y: number;
  width: number;
  height: number;
}

const escape = (value: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&'));

export function nodeElement(nodeId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${escape(nodeId)}"]`);
}

/** The field a type at this node (and port) writes in, or null when the card shows none. */
export function findTypeField(nodeId: string, handle?: string | null): TypeField | null {
  const node = nodeElement(nodeId);
  if (!node) return null;
  if (handle) {
    const port = node.querySelector(`.react-flow__handle[data-handleid="${escape(handle)}"]`);
    const label = port?.closest('.model-node__port-row')?.querySelector<HTMLElement>('.model-node__port-label');
    const text = label?.textContent?.replace(/\s*\+\s*$/, '').trim();
    if (label && text) return { kind: 'param', label: text, el: label };
  }
  const field = node.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea.model-node__textarea, input.model-node__textarea');
  return field ? { kind: 'text', el: field } : null;
}

const MIRRORED = [
  'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'textIndent',
  'tabSize', 'wordSpacing',
] as const;

/** The end of a field's text, in the field's own px (a mirror of it measures the wrap). */
function textEnd(field: HTMLTextAreaElement | HTMLInputElement): { x: number; y: number; lineHeight: number } {
  const style = getComputedStyle(field);
  const fontSize = parseFloat(style.fontSize) || 12;
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.25;
  const mirror = document.createElement('div');
  for (const key of MIRRORED) mirror.style[key] = style[key];
  const multiline = field instanceof HTMLTextAreaElement;
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.left = '-10000px';
  mirror.style.top = '0';
  mirror.style.whiteSpace = multiline ? 'pre-wrap' : 'pre';
  mirror.style.overflowWrap = 'break-word';
  mirror.textContent = field.value;
  const end = document.createElement('span');
  end.textContent = '\u200b';
  mirror.appendChild(end);
  document.body.appendChild(mirror);
  const x = end.offsetLeft - field.scrollLeft;
  const y = end.offsetTop - field.scrollTop;
  mirror.remove();
  // Inside the field's box, so text scrolled past its edge keeps the caret on the field.
  const maxX = Math.max(0, field.clientWidth - 2);
  const maxY = Math.max(0, field.clientHeight - lineHeight);
  return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY), lineHeight };
}

/** The mark's box for a field (flow units from the node's corner), or null. */
export function fieldBox(field: TypeField, nodeId: string, zoom: number, caretPx: number, underlinePx: number): FieldBox | null {
  const node = nodeElement(nodeId);
  if (!node || !field.el.isConnected) return null;
  const nodeRect = node.getBoundingClientRect();
  const rect = field.el.getBoundingClientRect();
  const z = zoom || 1;
  const left = (rect.left - nodeRect.left) / z;
  const top = (rect.top - nodeRect.top) / z;
  if (field.kind === 'param') {
    return { kind: 'underline', x: left, y: top + rect.height / z, width: rect.width / z, height: underlinePx };
  }
  const end = textEnd(field.el);
  // The mirror measures from inside its border; the field's box starts at its border.
  return { kind: 'caret', x: left + field.el.clientLeft + end.x, y: top + field.el.clientTop + end.y, width: caretPx, height: end.lineHeight };
}

/** Whether the field is on screen at all (else the caret goes to the say pill). */
export function onScreen(field: TypeField): boolean {
  if (typeof window === 'undefined' || !field.el.isConnected) return false;
  const r = field.el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
}
