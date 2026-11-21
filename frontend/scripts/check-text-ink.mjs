import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  collectCssFiles,
  compact,
  computeLineStarts,
  lineForOffset,
  parseDeclarations,
  parseRules,
  stripComments,
} from './lib/css-scan.mjs';

// Design: text takes the light ink, var(--sr-ink-light) (white at .55). Dimmer white measures under the
// 4.5:1 text needs on every surface the app draws (meta ink, white at .40, gives 3.6 to 3.9:1), so it
// is for non-text (borders, strokes, ticks, rules, backgrounds, shadows, decoration colours, swatches),
// for a disabled control, and for the icon-only controls named in ICON_ONLY below (an icon needs 3:1
// and .40 clears it). Hierarchy between two text lines is carried by size and weight.
//
// A second rule, below ("Thin text weight"): text at 9px or 10px takes weight 500.
//
// What fails: a TEXT declaration that resolves to white at an alpha above 0 and under .55. White at .20
// (--sr-ink-faint) and anything dimmer fail; alpha 0 (transparent text) is outside the check.
// TEXT properties are `color` (a ::placeholder rule's color included), `-webkit-text-fill-color`,
// `-webkit-text-stroke-color`, `caret-color`, and `fill` on a rule whose selector targets an SVG
// `text` or `tspan`. "Resolves to dim white" means:
//   - var(--sr-ink-meta, ...), var(--sr-ink-faint, ...), or var(--x) for any custom property that any rule in src defines as
//     dim white or as another such alias (followed to a fixed point, so a chain of any length is read);
//   - white at an alpha in that range as a literal in every form: rgba(255,255,255,.45), rgb(255 255
//     255 / 40%), #ffffff66, #fff8, hsla(0,0%,100%,.3), hsl(0 0% 100% / 50%).
// A fallback counts only when the variable is defined nowhere in src: var(--undefined, <dim>) fails.
// .55 and above pass.
//
// Exempt:
//   - a rule whose selector scopes to :disabled, [disabled] or [aria-disabled="true"] on the element
//     itself; every part of a comma list must be scoped, and every :is()/:where() alternative must be a
//     disabled state; :has() and :not() never scope; a disabled ancestor or earlier sibling does not
//     (DISABLED_SIBLING names the one sibling form that is allowed);
//   - the icon-only controls in ICON_ONLY, by exact selector (the part after `body.app-slava-restraint `),
//     only at meta ink (.40) or brighter: an icon needs 3:1 and white at .20 gives under 2:1, so an
//     ICON_ONLY selector at .20 or dimmer fails;
//   - the decoration in DECORATION, by exact selector: separators and thumbnail stand-ins that carry no
//     words (design keeps them at .20). Each is hidden from assistive tech (aria-hidden, or a ::before
//     whose content has empty alt text); tests/textInkCheck.test.ts fails when one loses that.
// Inline TSX: the file is parsed, and an object literal property whose key is a text colour (`color`,
// `caretColor`, `WebkitTextFillColor`, `WebkitTextStrokeColor`, or the quoted CSS name) and whose value
// is a string or a plain template that resolves to dim white fails. Comments, regex literals, nested
// templates and JSX text cannot hide or fake a match. A TS or TSX file that does not parse cleanly
// fails the check, naming the file and its first parse error.
//
// Rules with an unprefixed form and a `body.app-slava-restraint` twin are checked as written, both
// forms (the unprefixed one is dead CSS that check-skin-shadows reports; checking it as well is
// simpler and costs nothing).
//
// Known limits (this is a text check, not a CSS engine):
//   - nested CSS rules (`&`, or a `{` between declarations) are skipped;
//   - the value must be the colour itself: color-mix(...) of dim white, or a calc, is not followed;
//   - `opacity` over light ink is not multiplied in (color: var(--sr-ink-light) with opacity .36 reads
//     as .20 on screen and passes), and the `-webkit-text-stroke` shorthand is not read (only
//     `-webkit-text-stroke-color` is);
//   - a custom property defined as dim white in ANY rule makes every use of it dim, even where
//     another rule overrides it (--swatch is meta by default and overridden per swatch; it is only
//     read by background, so it passes);
//   - TSX: a colour built at run time (a template with a substitution, a function result) is not seen;
//   - a canvas or library colour passed as a prop (WaveformAudio's waveColor) is shape, not text;
//   - not seen: a colour held in a const (`color: META`), JSX colour props (`<Icon color=... />`),
//     `el.style.color = ...`, `style.setProperty(...)`, SVG `<text fill=...>` attributes, an inline
//     custom property that a CSS rule reads as a colour, `fill` on a class that sits on an SVG `<text>`
//     (only a selector ending in text/tspan is read), and `textPath`;
//   - computed keys (`['color']: ...`, a template-literal key) are not read;
//   - colour forms not read: color(), oklch(), oklab(), lab(), lch(), hwb(), relative colours
//     (`rgb(from ...)`), and calc() or var() inside a colour's channels;

const SRC = join(import.meta.dirname, '..', 'src');
const PREFIX = 'body.app-slava-restraint';

export const TEXT_PROPS = new Set(['color', '-webkit-text-fill-color', '-webkit-text-stroke-color', 'caret-color']);

// icon-only: colour tints an svg; non-text, 3:1. Exact selectors, without the body.app-slava-restraint prefix.
export const ICON_ONLY = new Set([
  '.agent-note-card__close',
  '.project-switch-toast__close',
  '.asset-trash__toast-close',
  '.reference-tray__remove',
  '.project-home__search svg',
  '.project-home__cover-close',
  '.project-home__rename',
  '.project-home__trash-toggle svg',
  '.project-home__toast-close',
  '.project-home__empty-search',
  '.project-home__notice-close',
  '.settings-pref--link svg',
  '.panel__header-action',
  '.model-node__header-action',
  '.connection-popup__category-chevron',
  '.connection-popup__close',
  '.chat__tool-icon',
  '.model-node__loop-toggle',
  '.panel__group-chevron',
  '.inspector__favorite-button',
  '.agent-log__hide',
  '.agent-log-hidden-notice__icon',
  '.editor-breadcrumb__arrow',
]);

// Decoration: separators and thumbnail stand-ins that carry no words. Design keeps them at .20. Exact
// selectors, without the body.app-slava-restraint prefix. Each must be hidden from assistive tech: an
// element with aria-hidden="true" in the TSX that renders it, or a ::before/::after whose content has
// empty alt text (content: "·" / ""). tests/textInkCheck.test.ts reads the TSX and CSS and fails when
// one of these loses that.
export const DECORATION = new Set([
  '.project-workspace-controls__count::before',
  '.agent-log-hidden-notice__sep',
  '.structured-preview__status-item + .structured-preview__status-item::before',
  '.character-rail__thumb-empty',
  '.character-palette__thumb-empty',
  '.moodboard-rail__thumb',
]);

const META_TOKEN = '--sr-ink-meta';

// Text white must be at least this alpha. Alphas from DIM_FLOOR (exclusive: 0 is transparent text, outside
// the check) to LIGHT_ALPHA (exclusive) fail.
const DIM_FLOOR = 0;
const LIGHT_ALPHA = 0.55;
// An icon-only control may sit at meta ink (.40, about 3.7:1 against the app's surfaces; an icon needs 3:1).
const META_ALPHA = 0.4;
const FAINT_TOKEN = '--sr-ink-faint';
const FAINT_ALPHA = 0.2;
const EPSILON = 1e-6;

function isDimAlpha(alpha) {
  return Number.isFinite(alpha) && alpha > DIM_FLOOR + EPSILON && alpha < LIGHT_ALPHA - EPSILON;
}

function parseAlpha(raw) {
  const text = raw.trim();
  return text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text);
}

/** The alpha of a whole value that is white in any literal form (hex, rgb, hsl), or null. */
function whiteAlpha(value) {
  const v = value.trim().toLowerCase().replace(/\s*!important$/, '').trim();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 4) return h.slice(0, 3) === 'fff' ? Number.parseInt(h[3] + h[3], 16) / 255 : null;
    if (h.length === 8) return h.slice(0, 6) === 'ffffff' ? Number.parseInt(h.slice(6), 16) / 255 : null;
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length !== 4) return null;
  const [a, b, c, alpha] = parts;
  const parsed = parseAlpha(alpha);
  if (!Number.isFinite(parsed)) return null;
  if (fn[1].startsWith('rgb')) return [a, b, c].every((n) => Number.parseFloat(n) === 255 || n === '100%') ? parsed : null;
  // hsl: lightness 100% is white whatever the hue and saturation.
  return Number.parseFloat(c) === 100 ? parsed : null;
}

/** Whether a whole value is white at a dim alpha (above 0 and under .55) in any literal form. */
export function isDimLiteral(value) {
  const alpha = whiteAlpha(value);
  return alpha !== null && isDimAlpha(alpha);
}

/** 1 for every character inside a quoted span (quotes included), 0 elsewhere. Backslash escapes are honoured. */
function quotedMask(text) {
  const mask = new Uint8Array(text.length);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== '"' && c !== "'") {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
    const end = Math.min(j, text.length - 1);
    for (let k = i; k <= end; k += 1) mask[k] = 1;
    i = j + 1;
  }
  return mask;
}

/** The first match of a regex whose start is outside any quoted span, or null. */
function matchOutsideQuotes(pattern, text) {
  const mask = quotedMask(text);
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(global)) if (!mask[match.index]) return match;
  return null;
}

export function splitTopLevel(text) {
  const mask = quotedMask(text);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (mask[i]) continue;
    const c = text[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

/**
 * The alpha a value resolves to when it is dim white, else null. dimVars maps each custom property that is
 * dim white (or an alias of one) to its lowest alpha; definedVars is every custom property defined anywhere
 * in src (a fallback only matters for a variable defined nowhere).
 */
export function dimAlphaOf(value, dimVars, definedVars) {
  const v = value.trim().replace(/\s*!important$/i, '').trim();
  const literal = whiteAlpha(v);
  if (literal !== null) return isDimAlpha(literal) ? literal : null;
  const wrapped = /^var\(([\s\S]*)\)$/i.exec(v);
  if (!wrapped) return null;
  const [name, ...rest] = splitTopLevel(wrapped[1]);
  if (dimVars.has(name)) return dimVars.get(name);
  if (definedVars.has(name) || rest.length === 0) return null;
  return dimAlphaOf(rest.join(','), dimVars, definedVars);
}

/** Whether a value resolves to dim white (see dimAlphaOf). */
export function resolvesToDim(value, dimVars, definedVars) {
  return dimAlphaOf(value, dimVars, definedVars) !== null;
}

/** Every custom property that is dim white or an alias of one, with its lowest alpha, followed to a fixed point. */
export function collectDimVars(sources) {
  const defs = new Map();
  for (const { source } of sources) {
    const css = stripComments(source);
    for (const rule of parseRules(css)) {
      if (rule.nested) continue;
      for (const { prop, value } of parseDeclarations(rule.body, rule.bodyStart)) {
        if (!prop.startsWith('--')) continue;
        if (!defs.has(prop)) defs.set(prop, []);
        defs.get(prop).push(value);
      }
    }
  }
  const definedVars = new Set(defs.keys());
  const dimVars = new Map([
    [META_TOKEN, META_ALPHA],
    [FAINT_TOKEN, FAINT_ALPHA],
  ]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, values] of defs) {
      if (name === META_TOKEN || name === FAINT_TOKEN) continue;
      const alphas = values.map((value) => dimAlphaOf(value, dimVars, definedVars)).filter((alpha) => alpha !== null);
      if (alphas.length === 0) continue;
      const lowest = Math.min(...alphas);
      if (dimVars.get(name) !== lowest) {
        dimVars.set(name, lowest);
        grew = true;
      }
    }
  }
  return { dimVars, definedVars };
}

export function splitList(selector) {
  return splitTopLevel(selector).map((part) => compact(part)).filter(Boolean);
}

const DISABLED = [/:disabled(?![\w-])/, /\[disabled\]/, /\[aria-disabled\s*=\s*["']?true["']?\]/];

// A disabled state on an earlier element (`.f[aria-disabled] ~ .key`) styles that other element, so it
// does not scope. This one is the exception: the field is aria-disabled and the "/" key hint beside it
// dims with it (design). Exact selector, without the body prefix.
export const DISABLED_SIBLING = new Set([".message-box__field[aria-disabled='true'] ~ .message-box__key"]);

/** The index of the `)` that closes the `(` at `open`. */
function closingParen(text, open) {
  const mask = quotedMask(text);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (mask[i]) continue;
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

/** Drop every `:not(...)` and `:has(...)` argument: neither one scopes a rule to a disabled control. */
export function dropNonScoping(part) {
  let out = part;
  for (;;) {
    const match = matchOutsideQuotes(/:(?:not|has)\(/, out);
    if (!match) return out;
    const open = match.index + match[0].length - 1;
    out = out.slice(0, match.index) + out.slice(closingParen(out, open) + 1);
  }
}

/** Expand :is(...) / :where(...) into one selector per alternative, until none is left. */
export function expandAlternatives(part) {
  const match = matchOutsideQuotes(/:(?:is|where)\(/, part);
  if (!match) return [part];
  const open = match.index + match[0].length - 1;
  const close = closingParen(part, open);
  const head = part.slice(0, match.index);
  const tail = part.slice(close + 1);
  return splitTopLevel(part.slice(open + 1, close)).flatMap((alt) => expandAlternatives(`${head}${alt}${tail}`));
}

/** The last compound selector: the part after the final combinator outside brackets and parentheses. */
export function lastCompound(part) {
  const mask = quotedMask(part);
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < part.length; i += 1) {
    if (mask[i]) continue;
    const c = part[i];
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) cut = i + 1;
  }
  return part.slice(cut);
}

/**
 * Whether one selector part applies only to a disabled control. Every :is()/:where() alternative must
 * be a disabled state; :not() and :has() never scope; the disabled state must sit on the subject itself
 * (the last compound), not on an ancestor or an earlier sibling, except the DISABLED_SIBLING selector.
 */
export function isDisabledScoped(part) {
  if (DISABLED_SIBLING.has(stripPrefix(part))) return true;
  return expandAlternatives(part).every((alt) => {
    const subject = lastCompound(dropNonScoping(alt));
    return DISABLED.some((pattern) => matchOutsideQuotes(pattern, subject) !== null);
  });
}

function stripPrefix(part) {
  return part.startsWith(`${PREFIX} `) ? part.slice(PREFIX.length + 1) : part;
}

/** One space around > + ~ and runs of spaces collapsed, so `.a+.b` and `.a  +  .b` match the listed `.a + .b`. */
export function normaliseCombinators(selector) {
  return selector.replace(/\s*([>+~])\s*/g, ' $1 ').replace(/\s+/g, ' ').trim();
}

function isIconOnly(part) {
  return expandAlternatives(normaliseCombinators(stripPrefix(part))).every((alt) => ICON_ONLY.has(normaliseCombinators(alt)));
}

function isDecoration(part) {
  return DECORATION.has(normaliseCombinators(stripPrefix(part)));
}

function isSvgTextSelector(part) {
  return expandAlternatives(part).some((alt) => /^(text|tspan)(?![\w-])/.test(lastCompound(alt.trim())));
}

/** The TEXT declarations in one stylesheet that resolve to meta ink and are not exempt. */
export function findCssTextInk(files, dimVars, definedVars) {
  const hits = [];
  for (const { file, source } of files) {
    const css = stripComments(source);
    const lineStarts = computeLineStarts(css);
    for (const rule of parseRules(css)) {
      if (rule.nested) continue;
      const parts = splitList(rule.selector);
      for (const decl of parseDeclarations(rule.body, rule.bodyStart)) {
        const textual = TEXT_PROPS.has(decl.prop) || (decl.prop === 'fill' && parts.some(isSvgTextSelector));
        if (!textual) continue;
        const alpha = dimAlphaOf(decl.value, dimVars, definedVars);
        if (alpha === null) continue;
        // Parts of the list this declaration reaches: for fill, only the svg text parts.
        const reached = decl.prop === 'fill' ? parts.filter(isSvgTextSelector) : parts;
        // An icon-only control is exempt at meta ink or brighter, not below it.
        const iconOk = alpha >= META_ALPHA - EPSILON;
        const live = reached.filter(
          (part) => !isDisabledScoped(part) && !isDecoration(part) && !(iconOk && isIconOnly(part)),
        );
        if (live.length === 0) continue;
        hits.push({
          file,
          line: lineForOffset(lineStarts, decl.offset),
          selector: live.join(', '),
          prop: decl.prop,
          value: decl.value,
          iconTooDim: live.some(isIconOnly),
        });
      }
    }
  }
  return hits;
}

const TSX_TEXT_KEYS = new Set([
  'color',
  'caretColor',
  'WebkitTextFillColor',
  'WebkitTextStrokeColor',
  '-webkit-text-fill-color',
  '-webkit-text-stroke-color',
  'caret-color',
]);

/** The text of a string literal or a plain template, through parentheses and `as` casts; else null. */
function literalText(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current) ? current.text : null;
}

/**
 * Inline TSX: the file is parsed, and an object literal property whose key is a text colour and whose
 * value is a string or plain template resolving to dim white is reported. A var() read is checked
 * against the same alias set.
 */
export function findTsxTextInk(files, dimVars, definedVars) {
  const hits = [];
  for (const { file, source } of files) {
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    // parseDiagnostics is not in TypeScript's public typings; it holds the syntax errors of this parse.
    const [parseError] = tree.parseDiagnostics ?? [];
    if (parseError) {
      const { line } = tree.getLineAndCharacterOfPosition(parseError.start ?? 0);
      hits.push({
        file,
        line: line + 1,
        selector: 'syntax error',
        prop: 'parse',
        value: ts.flattenDiagnosticMessageText(parseError.messageText, ' '),
        parseError: true,
      });
    }
    const visit = (node) => {
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
        const key = node.name.text;
        const value = TSX_TEXT_KEYS.has(key) ? literalText(node.initializer) : null;
        if (value !== null && resolvesToDim(value, dimVars, definedVars)) {
          const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
          hits.push({ file, line: line + 1, selector: 'inline style', prop: key, value });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return hits;
}

export const FAILURE_MESSAGE =
  'Text takes the light ink, var(--sr-ink-light). White dimmer than the light ink (any alpha above 0 and under .55: meta ink --sr-ink-meta at .40, faint ink --sr-ink-faint at .20 and anything dimmer) is for non-text (borders, strokes, ticks, backgrounds, shadows) and disabled controls, with two named exceptions: ICON_ONLY (icon-only controls, at meta ink or brighter, because an icon needs 3:1 and .20 gives under 2:1) and DECORATION (separators and thumbnail stand-ins hidden from assistive tech; design keeps them at .20). Put the text on var(--sr-ink-light); size and weight carry the hierarchy.';
export const ICON_TOO_DIM_NOTE =
  ' (an ICON_ONLY control must be at meta ink, var(--sr-ink-meta), or brighter: an icon needs 3:1)';

function collectFiles(dir, extensions) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...collectFiles(path, extensions));
    else if (extensions.some((ext) => entry.endsWith(ext))) out.push(path);
  }
  return out;
}

// ---- Thin text weight ----------------------------------------------------------------
// Design's ink rule for 9-10px text: weight 500. A rule that sets a 9px or 10px font-size (literal, or
// var(--sr-type-micro) / var(--sr-type-meta)) and does not set a weight of 500 or more in the same rule
// reads as weight 400 on the app's 400 base, and fails. Exempt: a mono face (font-family naming mono or
// monospace, or var(--sr-mono)), and the rules in THIN_TEXT_BASELINE: the rules that predate this check,
// by `file::selector`. The baseline only shrinks: a baseline entry whose rule no longer breaks the rule
// (fixed, deleted or renamed) fails the check until it is removed from the list. A new rule is never added
// to it: give the text weight 500, or put it in a mono face.
// Known limits: the weight is read from the same rule only (a weight set on an ancestor or by another rule
// for the same element is not seen, so such a rule is listed or given its own weight); `font:` shorthand is
// read for its weight word or number; em/rem/calc sizes are not read; nested rules are skipped.
export const THIN_SIZES = new Set(['9px', '10px']);
const THIN_TOKENS = new Set(['--sr-type-micro', '--sr-type-meta']);
export const THIN_TEXT_BASELINE = new Set([
  "components/agent-notes/agentNotes.css::.agent-notes-entry__who .agent-notes-dot",
  "components/agent-notes/agentNotes.css::.agent-questions-form__head .agent-notes-dot",
  "components/agent-notes/agentRoster.css::.agent-roster__row .agent-notes-dot",
  "components/brand/BrandShowcase.css::.nn-bs-card__state",
  "components/brand/BrandShowcase.css::.nn-bs-card__telemetry",
  "extraction/extraction.css::.ex-box-role",
  "extraction/extraction.css::.ex-origin",
  "styles/asset-move.css::.asset-move__caret",
  "styles/asset-proposals.css::.asset-proposal__edit-why",
  "styles/asset-trash.css::body.app-slava-restraint .asset-trash__note, body.app-slava-restraint .asset-trash__error",
  "styles/asset-trash.css::body.app-slava-restraint .asset-trash__sub",
  "styles/asset-trash.css::body.app-slava-restraint .moodboard-node__open-error, body.app-slava-restraint .character-node__open-error",
  "styles/batch-node.css::body.app-slava-restraint .batch-carousel__note",
  "styles/batch-node.css::body.app-slava-restraint .batch-node__guidance",
  "styles/camera-rig-node.css::body.app-slava-restraint .camera-rig-node__guidance",
  "styles/camera-rig-node.css::body.app-slava-restraint .camera-rig-node__slider-label",
  "styles/canvasProposals.css::.proposal-ghost__caption",
  "styles/canvasProposals.css::.proposal-ghost__category",
  "styles/canvasProposals.css::.proposal-ghost__cost",
  "styles/canvasProposals.css::.proposal-ghost__more",
  "styles/canvasProposals.css::.proposal-ring__tag",
  "styles/character-node.css::body.app-slava-restraint .character-node__thumb-placeholder",
  "styles/character-studio.css::body.app-slava-restraint .character-def__hint",
  "styles/character-studio.css::body.app-slava-restraint .character-def__ref-badge",
  "styles/character-studio.css::body.app-slava-restraint .character-def__thumb-empty",
  "styles/character-studio.css::body.app-slava-restraint .character-rail__sub, body.app-slava-restraint .character-palette__sub",
  "styles/cinema-node.css::body.app-slava-restraint .cinema-scene-node__input-label",
  "styles/cinema-node.css::body.app-slava-restraint .cinema-scene-node__shot-label",
  "styles/cinema-node.css::body.app-slava-restraint .cinema-scene-node__thumb-placeholder",
  "styles/cinema-studio.css::body.app-slava-restraint .cinema-shared-controls__ref-link",
  "styles/cinema-studio.css::body.app-slava-restraint .cinema-shared-controls__swatch-remove",
  "styles/cinema-studio.css::body.app-slava-restraint .cinema-shots-rail__badge",
  "styles/command-palette.css::.command-palette__group-label",
  "styles/commons-evaluation.css::.commons-evaluation small, .commons-eyebrow",
  "styles/commons-evaluation.css::.evaluation-axis>div",
  "styles/commons.css::body.app-slava-restraint .commons-badge",
  "styles/commons.css::body.app-slava-restraint .commons-region__label",
  "styles/commons.css::body.app-slava-restraint .commons-source",
  "styles/jev-result.css::body.app-slava-restraint .jev-result__footer",
  "styles/jev-result.css::body.app-slava-restraint .jev-result__more",
  "styles/jev-result.css::body.app-slava-restraint .jev-result__scale",
  "styles/jev-result.css::body.app-slava-restraint .model-node__jev-field-note",
  "styles/moodboard-node.css::body.app-slava-restraint .moodboard-node__output",
  "styles/moodboard-node.css::body.app-slava-restraint .moodboard-node__preview",
  "styles/moodboard-studio.css::body.app-slava-restraint .moodboard-color__flag",
  "styles/moodboard-studio.css::body.app-slava-restraint .moodboard-image-colors__item",
  "styles/moodboard-studio.css::body.app-slava-restraint .moodboard-rail__sub",
  "styles/moodboard-studio.css::body.app-slava-restraint .moodboard-rail__thumb",
  "styles/moodboard-studio.css::body.app-slava-restraint .moodboard-tile__cover",
  "styles/moodboard-studio.css::body.app-slava-restraint .moodboard-tile__note-hint",
  "styles/nodes.css::.model-node__error-details summary",
  "styles/nodes.css::.model-node__source-stale",
  "styles/outside-image-note.css::.outside-image-note",
  "styles/panels.css::.chat-panel__thinking-caret",
  "styles/panels.css::body.app-slava-restraint .chat-panel__scope-hint",
  "styles/paper-source-node.css::.paper-source-node__history",
  "styles/paper-source-node.css::.paper-source-node__identity code",
  "styles/paper-source-node.css::.paper-source-node__note, .paper-source-node__error",
  "styles/paper-source-node.css::.paper-source-node__output",
  "styles/paper-source-node.css::.paper-source-node__preview figcaption",
  "styles/paper-source-node.css::.paper-source-node__status",
  "styles/personal-agents.css::.permission-card__kind",
  "styles/personal-agents.css::.permission-card__timer",
  "styles/provider-switcher.css::body.app-slava-restraint .provider-switcher__block",
  "styles/provider-switcher.css::body.app-slava-restraint .provider-switcher__info",
  "styles/reference-set-node.css::body.app-slava-restraint .reference-set-node__guidance",
  "styles/reference-set-node.css::body.app-slava-restraint .reference-set-node__preview-empty",
  "styles/reference-set-node.css::body.app-slava-restraint .reference-set-node__preview-weight",
  "styles/reference-set-node.css::body.app-slava-restraint .reference-set-node__weight-value",
  "styles/run-history.css::.run-history__paper-details",
  "styles/run-history.css::.run-history__paper-snapshot code",
  "styles/run-history.css::.run-history__paper-stale",
  "styles/run-history.css::.run-history__replay",
  "styles/run-history.css::.run-history__replay-blocked",
  "styles/run-history.css::.run-history__safeguards",
  "styles/run-history.css::.run-history__status",
  "styles/run-history.css::.run-history__status-note",
  "styles/slava-restraint.css::body.app-slava-restraint .agent-log__source",
  "styles/slava-restraint.css::body.app-slava-restraint .connection-popup__category-label",
  "styles/slava-restraint.css::body.app-slava-restraint .edit-node__title",
  "styles/slava-restraint.css::body.app-slava-restraint .editor-transport__label",
  "styles/slava-restraint.css::body.app-slava-restraint :is(.model-node--text-input, .model-node--image-surface) .model-node__port-label",
  "styles/spatial-preview.css::.spatial-preview__subtitle",
  "styles/structured-preview.css::body.app-slava-restraint .structured-preview .structured-preview__swatch-label",
  "styles/world-preview.css::.world-modal__download-error",
  "styles/world-preview.css::body.app-slava-restraint .world-modal__eyebrow",
  "styles/world-preview.css::body.app-slava-restraint .world-modal__help",
  "styles/world-preview.css::body.app-slava-restraint .world-preview__badge",
  "styles/world-preview.css::body.app-slava-restraint .world-preview__copy span",
  "styles/world-preview.css::body.app-slava-restraint .world-preview__cta",
]);

function thinSize(value) {
  const v = value.trim().replace(/\s*!important$/i, '').trim().toLowerCase();
  if (THIN_SIZES.has(v)) return v;
  const wrapped = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(v);
  if (!wrapped) return null;
  if (THIN_TOKENS.has(wrapped[1])) return v;
  return null;
}

const MONO = /mono/i;

/** True when the first family of a font-family list is a mono face; a mono fallback after a UI face does not count. */
function firstFamilyIsMono(list) {
  const first = splitTopLevel(list)[0] ?? '';
  return MONO.test(first);
}

/** Reads the declarations in order and returns the weight and the family list that win. A font shorthand resets both. */
function fontStyleOf(decls) {
  let weight = null;
  let mono = false;
  for (const { prop, value } of decls) {
    const v = value.trim().replace(/\s*!important$/i, '').trim().toLowerCase();
    if (prop === 'font-weight') {
      weight = v === 'normal' ? 400 : v === 'bold' ? 700 : v === 'bolder' ? 700 : v === 'lighter' ? 300 : Number.parseFloat(v);
      if (!Number.isFinite(weight)) weight = 400;
    } else if (prop === 'font-family') {
      mono = firstFamilyIsMono(v);
    } else if (prop === 'font') {
      const word = /(?:^|\s)(normal|bold|bolder|lighter|[1-9]00)(?=\s)/.exec(v);
      weight = word ? (word[1] === 'normal' ? 400 : /^bold/.test(word[1]) ? 700 : word[1] === 'lighter' ? 300 : Number(word[1])) : 400;
      const fam = /(?:^|\s)(?:[\d.]+(?:px|rem|em|pt|%)|var\([^)]*\))(?:\/\S+)?\s+(.+)$/.exec(v);
      mono = fam ? firstFamilyIsMono(fam[1]) : false;
    }
  }
  return { weight, mono };
}

/** The rules that set a 9px or 10px size with no weight of 500 or more and no mono face. */
export function findThinText(files) {
  const hits = [];
  for (const { file, source } of files) {
    const css = stripComments(source);
    const lineStarts = computeLineStarts(css);
    for (const rule of parseRules(css)) {
      if (rule.nested) continue;
      const decls = parseDeclarations(rule.body, rule.bodyStart);
      const size = decls.find((d) => (d.prop === 'font-size' || d.prop === 'font') && thinSize(d.prop === 'font' ? (/(?:^|\s)(9px|10px)(?:\/|\s|$)/.exec(d.value.toLowerCase())?.[1] ?? '') : d.value));
      if (!size) continue;
      const { weight, mono } = fontStyleOf(decls);
      if (mono) continue;
      if (weight !== null && weight >= 500) continue;
      hits.push({ file, line: lineForOffset(lineStarts, size.offset), selector: compact(rule.selector), key: `${file}::${compact(rule.selector)}`, size: size.value, weight: weight ?? 'none (400)' });
    }
  }
  return hits;
}

/** The failures: a thin-text rule not in the baseline, and a baseline entry that no longer applies. */
export function thinTextFailures(files, baseline = THIN_TEXT_BASELINE) {
  const hits = findThinText(files);
  const keys = new Set(hits.map((hit) => hit.key));
  return {
    fresh: hits.filter((hit) => !baseline.has(hit.key)),
    stale: [...baseline].filter((key) => !keys.has(key)),
  };
}


export function scan(cssFiles, tsxFiles) {
  const { dimVars, definedVars } = collectDimVars(cssFiles);
  return [...findCssTextInk(cssFiles, dimVars, definedVars), ...findTsxTextInk(tsxFiles, dimVars, definedVars)];
}

function main() {
  const read = (path) => ({ file: relative(SRC, path), source: readFileSync(path, 'utf8') });
  const cssFiles = collectCssFiles(SRC).map(read);
  const tsxFiles = collectFiles(SRC, ['.tsx', '.ts']).map(read);
  const hits = scan(cssFiles, tsxFiles);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(hits, null, 1));
    return;
  }
  const thin = thinTextFailures(cssFiles);
  if (thin.fresh.length > 0 || thin.stale.length > 0) {
    console.error('Text at 9px or 10px takes weight 500, or a mono face. Set font-weight: 500 on the rule, or use var(--sr-mono).');
    for (const hit of thin.fresh) console.error(`  src/${hit.file}:${hit.line} ${hit.selector} sets font-size: ${hit.size} with weight ${hit.weight}`);
    for (const key of thin.stale) console.error(`  THIN_TEXT_BASELINE lists ${key}, which no longer breaks the rule: remove it from the list (it only shrinks)`);
    process.exit(1);
  }
  if (hits.length > 0) {
    console.error(FAILURE_MESSAGE);
    for (const hit of hits) {
      console.error(
        hit.parseError
          ? `  src/${hit.file}:${hit.line} does not parse, so it was not checked: ${hit.value}`
          : `  src/${hit.file}:${hit.line} ${hit.selector} sets ${hit.prop}: ${hit.value}${hit.iconTooDim ? ICON_TOO_DIM_NOTE : ''}`,
      );
    }
    process.exit(1);
  }
  console.log(`Text-ink guard passed (${cssFiles.length} stylesheets, ${tsxFiles.length} TS files scanned).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
