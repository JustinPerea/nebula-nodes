/**
 * GM r14 (4), PR #204 round 9: "A because line destroys nothing, so it never gets the warning
 * colour on any surface. Check that it's the one shared style, not a per-screen fix."
 *
 * The shared style: <LineText> marks the element a because line registers on
 * (`data-line-because`), and styles/becauseLine.css turns every warning token inside it into the
 * neutral ink, edge and surface. This ratchet holds that in place:
 *
 * 1. LineText (and FailureLines and CommonsErrorLine, which render through it) marks a because
 *    line, and only a because line, and unmarks it when the words change or go.
 * 2. The sheet ships with LineText and covers every warning token the app defines (a token named
 *    for the accent, an error, a danger or a warning), except the few in NOT_LINE_TOKENS.
 * 3. Every CSS rule for an element a line renders in (found from the JSX: the element that holds
 *    a LineText, FailureLines or CommonsErrorLine) colours it only through tokens the sheet
 *    covers or neutral values: no warning-hued literal, no warning token the sheet leaves out.
 *    So a because line can't take the warning colour, whichever screen draws it.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { LineText } from '../src/components/LineText';
import { CommonsErrorLine } from '../src/components/commons/CommonsErrorLine';
import { notConnectedBecause } from '../src/lib/errorCopy';
import { resetLinesForTests } from '../src/lib/notConnectedLine';

const SRC = join(__dirname, '..', 'src');
const files = (dir: string, ext: RegExp): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path, ext);
  return ext.test(name) && !name.includes('.test.') ? [path] : [];
});
const rel = (path: string) => relative(SRC, path);

const BECAUSE = notConnectedBecause('load the connected apps');
const LOCK = 'You can connect an agent when this tab is connected as you.';
const OTHER = 'Couldn’t load the connected apps. Nebula didn’t respond. Try again.';

afterEach(() => { cleanup(); resetLinesForTests(); });

describe('GM r14 (4): a because line is marked, and only a because line', () => {
  it('bare words mark the surface\'s own element; words in a span mark the span', () => {
    const view = render(<div>
      <p className="settings-row__error" data-testid="bare"><LineText text={BECAUSE} /></p>
      <p data-testid="span-holder"><LineText className="x" text={BECAUSE} /></p>
      <p className="settings-row__error" data-testid="lock"><LineText text={LOCK} /></p>
      <p className="settings-row__error" data-testid="other"><LineText text={OTHER} /></p>
    </div>);
    expect(view.getByTestId('bare').getAttribute('data-line-because')).toBe('');
    expect(view.getByTestId('span-holder').querySelector('.x')!.getAttribute('data-line-because')).toBe('own');
    expect(view.getByTestId('lock').hasAttribute('data-line-because')).toBe(false);
    expect(view.getByTestId('other').hasAttribute('data-line-because')).toBe(false);
  });

  it('the mark goes when the words change to another line, and when they go', () => {
    const handle: { set: Dispatch<SetStateAction<string | null>> } = { set: () => {} };
    function Holder() {
      const [line, setLine] = useState<string | null>(BECAUSE);
      useEffect(() => { handle.set = setLine; }, []);
      return <p data-testid="line"><LineText text={line} /></p>;
    }
    const view = render(<Holder />);
    expect(view.getByTestId('line').hasAttribute('data-line-because')).toBe(true);
    act(() => handle.set(OTHER));
    expect(view.getByTestId('line').hasAttribute('data-line-because')).toBe(false);
    act(() => handle.set(BECAUSE));
    expect(view.getByTestId('line').hasAttribute('data-line-because')).toBe(true);
    act(() => handle.set(null));
    expect(view.getByTestId('line').hasAttribute('data-line-because')).toBe(false);
  });

  it('the Commons line takes the same mark, with one class for every line (no per-screen neutral class)', () => {
    const view = render(<div><CommonsErrorLine line={BECAUSE} /><CommonsErrorLine line={OTHER} /></div>);
    const [because, other] = [...view.container.querySelectorAll('p')];
    expect(because.className).toBe(other.className);
    expect(because.getAttribute('data-line-because')).toBe('');
    expect(other.hasAttribute('data-line-because')).toBe(false);
  });
});

/** Custom properties a line's colour may come through, by name. */
const WARNING_TOKEN = /^--(?:sr-(?:[\w-]+-)?(?:accent|error|danger|warn(?:ing)?)|line-warning)(?:-|$)/;
/** Warning-named tokens a line never reads, and why. */
const NOT_LINE_TOKENS: Record<string, string> = {
  '--sr-on-accent': 'ink on an accent fill (a primary button), never a line',
  '--sr-on-danger': 'ink on a danger fill (a destructive button), never a line',
  '--sr-danger-fill': 'a destructive button\'s fill',
  '--sr-danger-fill-hover': 'a destructive button\'s fill on hover',
  '--sr-node-error-bg': 'a node card\'s error panel ground: near-black, not a warning hue',
  '--sr-node-error-border-width': 'a width',
  '--sr-node-error-margin': 'a length',
  '--sr-node-error-padding': 'a length',
  '--sr-node-error-radius': 'a radius',
};

const css = files(SRC, /\.css$/).map((path) => ({ file: rel(path), text: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }));
const SHEET = 'styles/becauseLine.css';
const sheet = () => css.find((entry) => entry.file === SHEET)!.text;
const neutralised = () => new Set([...sheet().matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));

describe('GM r14 (4): one shared sheet covers every warning token', () => {
  it('ships with LineText, so every surface that shows a line has it', () => {
    expect(readFileSync(join(SRC, 'components/LineText.tsx'), 'utf8')).toMatch(/import '\.\.\/styles\/becauseLine\.css';/);
    expect(sheet()).toMatch(/\[data-line-because\]/);
  });

  it('every warning token the app defines is turned neutral there, or listed as never a line\'s', () => {
    const defined = new Set<string>();
    for (const { file, text } of css) {
      if (file === SHEET) continue;
      for (const match of text.matchAll(/(--sr-[\w-]+)\s*:/g)) if (WARNING_TOKEN.test(match[1])) defined.add(match[1]);
    }
    const covered = neutralised();
    const missing = [...defined].filter((token) => !covered.has(token) && !(token in NOT_LINE_TOKENS)).sort();
    expect(missing).toEqual([]);
    expect(defined.size).toBeGreaterThan(10);
  });

  it('nothing else sets a style on a because line, so nothing can put the warning colour back', () => {
    const others = css.filter(({ file, text }) => file !== SHEET && /data-line-because/.test(text)).map(({ file }) => file);
    expect(others).toEqual([]);
  });
});

/** The class words of a JSX element's className, where they are written out. */
function classWords(element: ts.JsxOpeningLikeElement): string[] {
  const words: string[] = [];
  for (const attribute of element.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== 'className' || !attribute.initializer) continue;
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        words.push(...node.text.split(/\s+/).filter((word) => /^[a-z][\w-]*$/i.test(word)));
      }
      ts.forEachChild(node, visit);
    };
    visit(attribute.initializer);
  }
  return words;
}

const LINE_TAGS = new Set(['LineText', 'FailureLines', 'CommonsErrorLine']);

/** Every class a line can render in: the element holding a line component, and a LineText's own span. */
export function lineClasses(sources = files(SRC, /\.tsx$/)): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (word: string, where: string) => found.set(word, [...(found.get(word) ?? []), where]);
  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = node.tagName.getText();
        if (LINE_TAGS.has(tag)) {
          for (const word of classWords(node)) add(word, rel(path));
          // The nearest enclosing element is where its words' colour comes from.
          for (let up: ts.Node | undefined = (ts.isJsxOpeningElement(node) ? node.parent : node).parent; up; up = up.parent) {
            if (ts.isJsxElement(up)) { for (const word of classWords(up.openingElement)) add(word, rel(path)); break; }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

/** A component's own name for a JSX tag's function, when the tag is one (capitalised). */
const isComponent = (tag: string) => /^[A-Z]/.test(tag);

/**
 * Review 8 MEDIUM-1 (PR #204 round 10): every element around a line, up to its component's root
 * (the box it sits in: a rail, a border, a fill), with each className resolved: written words, a
 * prop's default (`className = 'model-node__error'`) and the words every caller passes for it.
 * `boxed`: the element carries `data-line-box`, so styles/becauseLine.css neutralises it while a
 * because line is inside; any other box must colour itself neutrally whatever it holds.
 */
export function boxClasses(
  sources: { path: string; text: string }[] = files(SRC, /\.tsx$/).map((path) => ({ path, text: readFileSync(path, 'utf8') })),
): Map<string, { where: string[]; boxed: boolean }> {
  const parsed = sources.map(({ path, text }) => ({ path, file: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) }));
  // Every JSX use of each component, by name: its words for className are read on demand, through
  // a caller that hands on its own className prop (NodeRunError -> NodeError), a few levels deep.
  const uses = new Map<string, ts.JsxOpeningLikeElement[]>();
  for (const { file } of parsed) {
    const visit = (node: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && isComponent(node.tagName.getText())) {
        const name = node.tagName.getText().split('.').pop()!;
        uses.set(name, [...(uses.get(name) ?? []), node]);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const passed = (component: string, depth = 0): string[] => depth > 4 ? [] : (uses.get(component) ?? [])
    .flatMap((use) => [...classWords(use), ...resolvedClassName(use, (name) => passed(name, depth + 1))]);
  const found = new Map<string, { where: string[]; boxed: boolean }>();
  const add = (word: string, where: string, boxed: boolean) => {
    const entry = found.get(word) ?? { where: [], boxed: true };
    found.set(word, { where: [...entry.where, where], boxed: entry.boxed && boxed });
  };
  for (const { path, file } of parsed) {
    const visit = (node: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && LINE_TAGS.has(node.tagName.getText())) {
        let nearest = true;
        for (let up: ts.Node | undefined = (ts.isJsxOpeningElement(node) ? node.parent : node).parent; up; up = up.parent) {
          // The component's root: its own element is the last one walked. A callback inside it (a
          // .map's, a render prop's) is walked through, up to the component.
          if (ts.isFunctionDeclaration(up) || ts.isArrowFunction(up) || ts.isFunctionExpression(up)) {
            const name = ts.isFunctionDeclaration(up) ? up.name?.text
              : ts.isVariableDeclaration(up.parent) ? up.parent.name.getText() : undefined;
            if (name === undefined || isComponent(name)) { if (name !== undefined || !ts.isCallExpression(up.parent)) break; }
          }
          if (!ts.isJsxElement(up)) continue;
          if (nearest) { nearest = false; continue; } // the line's own element: lineClasses' rule
          const opening = up.openingElement;
          const boxed = opening.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'data-line-box');
          const words = [...classWords(opening), ...resolvedClassName(opening, passed)];
          for (const word of words) add(word, rel(path), boxed);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

/** The words a className expression gets from a prop: its default and what callers pass. */
function resolvedClassName(element: ts.JsxOpeningLikeElement, passed: (component: string) => string[]): string[] {
  const words: string[] = [];
  for (const attribute of element.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== 'className' || !attribute.initializer) continue;
    const names = new Set<string>();
    const visit = (node: ts.Node) => { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, visit); };
    visit(attribute.initializer);
    for (let up: ts.Node | undefined = element.parent; up; up = up.parent) {
      if (!(ts.isFunctionDeclaration(up) || ts.isArrowFunction(up) || ts.isFunctionExpression(up))) continue;
      const [props] = up.parameters;
      if (props && ts.isObjectBindingPattern(props.name)) {
        for (const binding of props.name.elements) {
          const local = binding.name.getText();
          if (!names.has(local)) continue;
          if (binding.initializer && ts.isStringLiteralLike(binding.initializer)) words.push(...binding.initializer.text.split(/\s+/));
          const component = ts.isFunctionDeclaration(up) ? up.name?.text : ts.isVariableDeclaration(up.parent) ? up.parent.name.getText() : undefined;
          if (component && (binding.propertyName?.getText() ?? local) === 'className') words.push(...passed(component));
        }
      }
      break;
    }
  }
  return words.filter((word) => /^[a-z][\w-]*$/i.test(word));
}

/** Elements around a line that aren't its box, and why: a card's selection state is the card's. */
const NOT_BOXES: Record<string, string> = {
  'batch-node--selected': 'the batch card\'s selection outline (the card, not the line\'s box)',
  'paper-source-node--selected': 'the Paper card\'s selection outline',
  'result-card--compared': 'a Create result picked for comparing',
  'mesh-modal__fallback': 'the 3D preview\'s fallback ground, tinted by the node\'s category colour',
};

/** Box properties: what draws the box a line sits in, and the colour it hands down. */
const BOX_PROPS = /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|inline|block)(?:-start|-end)?)?(?:-color)?|outline(?:-color)?|box-shadow)$/;

/** Each rule that gives a box around a line a warning rail, border, fill or colour. Inside a box no
 * token is neutralised (the sheet's overrides sit on the line's element), so a warning token counts
 * as much as a literal. */
export function warningBoxes(sheets: { file: string; text: string }[], classes: Set<string>): string[] {
  const wrong: string[] = [];
  for (const { file, text } of sheets) {
    if (file === SHEET) continue;
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1].trim().split(/,(?![^(]*\))/).map((part) => part.trim());
      const hits = selectors.filter((selector) => {
        const last = selector.split(/\s*[>+~]\s*|\s+(?![^(]*\))/).pop() ?? '';
        if (/:(?:hover|focus|focus-visible|active|disabled)\b/.test(last)) return false;
        const words = [...last.replace(/:(?:is|where|not|has)\([^)]*\)/g, '').matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
        return words.some((word) => classes.has(word));
      });
      if (!hits.length) continue;
      for (const declaration of rule[2].split(';')) {
        const [prop, ...rest] = declaration.split(':');
        const name = prop?.trim();
        const value = rest.join(':').trim();
        if (!name || !value || !BOX_PROPS.test(name)) continue;
        const tokens = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
        if (tokens.some((token) => WARNING_TOKEN.test(token) && !(token in NOT_LINE_TOKENS)) || warningLiteral(value)) {
          wrong.push(`${file}: ${hits[0]} { ${name}: ${value} }`);
        }
      }
    }
  }
  return wrong;
}

/** A literal colour's hue family: whether it is a warning (red, orange, amber, yellow). */
export function warningLiteral(value: string): boolean {
  const withoutVars = value.replace(/var\((?:[^()]|\([^()]*\))*\)/g, '');
  const colours = [...withoutVars.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi)].map((match) => match[0]);
  if (/\b(?:red|orange|orangered|tomato|crimson|gold|yellow|coral|darkorange|firebrick)\b/i.test(withoutVars)) return true;
  return colours.some((colour) => {
    let r: number, g: number, b: number;
    if (colour.startsWith('#')) {
      const hex = colour.slice(1);
      const full = hex.length <= 4 ? hex.split('').map((c) => c + c).join('') : hex;
      [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    } else if (/^rgb/i.test(colour)) {
      [r, g, b] = colour.replace(/^[^(]*\(|\)$/g, '').split(/[\s,/]+/).slice(0, 3).map(Number);
    } else {
      const [h, s] = colour.replace(/^[^(]*\(|\)$/g, '').split(/[\s,/]+/).map((part) => parseFloat(part));
      return s > 35 && (h <= 65 || h >= 335);
    }
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === 0 || (max - min) / max < 0.35) return false;
    let hue: number;
    if (max === r) hue = ((g - b) / (max - min)) * 60;
    else if (max === g) hue = (2 + (b - r) / (max - min)) * 60;
    else hue = (4 + (r - g) / (max - min)) * 60;
    if (hue < 0) hue += 360;
    return hue <= 65 || hue >= 335;
  });
}

const COLOUR_PROPS = /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|inline|block)(?:-start|-end)?)?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-decoration(?:-color)?|-webkit-text-fill-color|caret-color)$/;

/** Each declaration that could give a line element the warning colour. */
export function warningDeclarations(sheets: { file: string; text: string }[], classes: Set<string>, covered: Set<string>): string[] {
  const wrong: string[] = [];
  for (const { file, text } of sheets) {
    if (file === SHEET) continue;
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1].trim().split(/,(?![^(]*\))/).map((part) => part.trim());
      // The element the rule styles: the last compound selector's classes (a button's state rules are buttons, not lines).
      const hits = selectors.filter((selector) => {
        const last = selector.split(/\s*[>+~]\s*|\s+(?![^(]*\))/).pop() ?? '';
        const words = [...last.replace(/:(?:is|where|not|has)\([^)]*\)/g, '').matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
        return words.some((word) => classes.has(word));
      });
      if (!hits.length) continue;
      for (const declaration of rule[2].split(';')) {
        const [prop, ...rest] = declaration.split(':');
        const name = prop?.trim();
        const value = rest.join(':').trim();
        if (!name || !value || !COLOUR_PROPS.test(name)) continue;
        const tokens = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]);
        // A warning token the sheet leaves out, or a warning literal as the fallback of a token the
        // sheet doesn't set (`var(--line-warning, #e0796b)` is the hook; `var(--other, #e0796b)` isn't).
        const fallbacks = [...value.matchAll(/var\(\s*(--[\w-]+)\s*,([^()]*(?:\([^()]*\))?[^()]*)\)/g)]
          .filter((match) => !covered.has(match[1]) && warningLiteral(match[2].trim())).map((match) => match[1]);
        const outside = [...tokens.filter((token) => WARNING_TOKEN.test(token) && !covered.has(token)), ...fallbacks];
        if (outside.length || warningLiteral(value)) wrong.push(`${file}: ${hits[0]} { ${name}: ${value} }`);
      }
    }
  }
  return wrong;
}

describe('GM r14 (4): no line element takes a warning colour another way', () => {
  it('finds the elements lines render in', () => {
    const classes = lineClasses();
    for (const word of ['settings-row__error', 'commons-notice', 'failure-lines__reason']) expect(classes.has(word), word).toBe(true);
  });

  it('every rule for a line element colours it through a token the sheet turns neutral, or a neutral value', () => {
    expect(warningDeclarations(css, new Set(lineClasses().keys()), neutralised())).toEqual([]);
  });

  it('catches each way round it', () => {
    const classes = new Set(['x-line']);
    const covered = neutralised();
    const probe = (body: string) => warningDeclarations([{ file: 'probe.css', text: `.panel .x-line { ${body} }` }], classes, covered);
    expect(probe('color: #ff5a1f;')).toHaveLength(1);
    expect(probe('color: rgb(255, 136, 125);')).toHaveLength(1);
    expect(probe('border-left: 2px solid hsl(20 90% 50%);')).toHaveLength(1);
    expect(probe('color: tomato;')).toHaveLength(1);
    expect(probe('color: var(--sr-warning-new);')).toHaveLength(1);
    expect(probe('color: var(--sr-danger);')).toHaveLength(0);
    expect(probe('color: var(--sr-danger, #ff887d);')).toHaveLength(0);
    expect(probe('color: var(--line-warning, #e0796b);')).toHaveLength(0);
    expect(probe('color: var(--made-up, #e0796b);')).toHaveLength(1);
    expect(probe('border-top: 1px solid var(--made-up, rgba(255, 210, 122, 0.15));')).toHaveLength(1);
    expect(probe('color: rgba(255, 255, 255, 0.55); background: #222;')).toHaveLength(0);
    expect(warningDeclarations([{ file: 'probe.css', text: '.x-line:hover, .other { color: #e5484d }' }], classes, covered)).toHaveLength(1);
    expect(warningDeclarations([{ file: 'probe.css', text: '.x-line .icon { color: #e5484d }' }], classes, covered)).toHaveLength(0);
  });
});

describe('review 8 MEDIUM-1: the box around a because line goes neutral too (GM r16 Q1)', () => {
  it('walks every element up to the component root, with className props and their defaults', () => {
    const boxes = boxClasses();
    expect(boxes.get('model-node__error')?.boxed, 'NodeError: the default className').toBe(true);
    expect(boxes.get('project-home__error')?.boxed, 'Projects ' + JSON.stringify(boxes.get('project-home__error'))).toBe(true);
    // A caller's className for NodeError is read too (the card's own run-error class).
    expect([...boxes.keys()].some((word) => /__run-error$/.test(word))).toBe(true);
  });

  it('every box that isn\'t marked data-line-box colours itself neutrally', () => {
    const unmarked = new Set([...boxClasses()].filter(([word, entry]) => !entry.boxed && !(word in NOT_BOXES)).map(([word]) => word));
    expect(warningBoxes(css, unmarked)).toEqual([]);
  });

  it('a marked box: the sheet neutralises its rail, border and fill while a because line is inside', () => {
    expect(sheet()).toMatch(/\[data-line-box\]:has\(\[data-line-because\]\)/);
    const rule = sheet().slice(sheet().lastIndexOf('[data-line-box]:has([data-line-because]) {'));
    const body = rule.slice(0, rule.indexOf('}'));
    for (const prop of ['color', 'background-color', 'border-color']) expect(body).toMatch(new RegExp(`\\b${prop}:[^;]*!important`));
  });

  it('catches each way round it', () => {
    const classes = new Set(['x-box']);
    const probe = (body: string) => warningBoxes([{ file: 'probe.css', text: `.x-box { ${body} }` }], classes);
    expect(probe('border-left: 2px solid var(--sr-accent);')).toHaveLength(1);
    expect(probe('background: var(--sr-error-soft);')).toHaveLength(1);
    expect(probe('border: 1px solid var(--sr-error-border);')).toHaveLength(1);
    expect(probe('background: rgba(255, 90, 31, 0.12);')).toHaveLength(1);
    expect(probe('color: var(--sr-warning);')).toHaveLength(1);
    expect(probe('background: var(--sr-node-error-bg); border: 1px solid var(--sr-edge-strong);')).toHaveLength(0);
    // A default className and a caller's className are both read.
    const text = 'function Box({ className = "x-default" }) { return <div className={className}><p><LineText text="t" /></p></div>; }\n'
      + 'function Use() { return <Box className="x-passed" />; }\n'
      + 'function Marked() { return <div className="x-marked" data-line-box=""><p><LineText text="t" /></p></div>; }\n'
      + 'function Deep() { return <section className="x-outer"><div><p><LineText text="t" /></p></div></section>; }\n'
      + 'function List({ items }) { return <ul className="x-list">{items.map((i) => <li key={i}><p><LineText text="t" /></p></li>)}</ul>; }\n'
      + 'function Run({ className }) { return <Box className={`${className} x-run`} />; }\n'
      + 'function UseRun() { return <Run className="x-card__run-error" />; }';
    const found = boxClasses([{ path: join(SRC, 'probe.tsx'), text }]);
    expect([...found.keys()].sort()).toEqual(['x-card__run-error', 'x-default', 'x-list', 'x-marked', 'x-outer', 'x-passed', 'x-run']);
    expect(found.get('x-marked')!.boxed).toBe(true);
    expect(found.get('x-default')!.boxed).toBe(false);
  });
});
