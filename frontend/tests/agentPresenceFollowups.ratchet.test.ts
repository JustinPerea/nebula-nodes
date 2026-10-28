import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { gatedGraphActions } from '../src/store/graphStore';

/**
 * Follow-ups to PR #195, two static ratchets.
 *
 * 1. Review 23 L-4: round 23's ratchet (round23Surfaces.test.tsx gatedUses)
 *    saw `(s) => s.X`, `getState().X`, `store.X` and `lifecycle.X` only, and
 *    missed `const graph = useGraphStore.getState(); graph.X()`, destructures,
 *    useShallow, a bare `s => s.X` and `const { X } = useGraphStore()`
 *    (review 23 ratchet.facts B-F); EditorView's keys and the chat's Apply
 *    and /clear slipped through. Now any name of a gated action (EDIT_GATES,
 *    gatedGraphActions) anywhere in a file that imports useGraphStore counts,
 *    in every form, comments and string literals aside. Each such file reads
 *    the canvas lock (useCanvasLock / refuseCanvasEdit), or names the locked
 *    surfaces it hands its controls to, or is on ALLOWLIST with the reason it
 *    has no control of its own that edits.
 *
 * 2. GM r24 item 2: one disabled rule app-wide. A disabled button is neutral
 *    grey whatever the reason, and its tooltip gives the reason; never orange
 *    but disabled. Every button-like rule that fills with the accent (orange)
 *    is covered by the one shared disabled rule (styles/disabled-buttons.css,
 *    imported by App.tsx).
 */

const SRC = join(__dirname, '../src');
const walk = (dir: string, match: RegExp): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path, match) : match.test(name) && !/\.test\./.test(name) ? [path] : [];
});

/** Fix round 1 of PR #200 (review L-5): the source read by the TypeScript
 * parser, not by regexes. Comments and string literals are no code (a
 * `/*` inside `accept="image/*"` hid 315 lines of Inspector.tsx from the
 * old regex, and `title="Don't"` hid the rest of its line); identifiers in
 * every form count, and so does bracket access by a string
 * (`s['executeGraph']`). */
const parsed = new Map<string, ts.SourceFile>();
function parse(source: string, file = 'x.tsx'): ts.SourceFile {
  const key = `${file}\u0000${source}`;
  let root = parsed.get(key);
  if (!root) {
    root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
    parsed.set(key, root);
  }
  return root;
}
const named = new WeakMap<ts.Node, string[]>();
function identifiers(node: ts.Node): string[] {
  const cached = named.get(node);
  if (cached) return cached;
  const names = identifiersOf(node);
  named.set(node, names);
  return names;
}
function identifiersOf(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) names.push(current.text);
    else if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) names.push(current.argumentExpression.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

const GATED = new Set(gatedGraphActions());

/** Every gated action a file names, in any form. */
function gatedNames(source: string, file?: string): string[] {
  return [...new Set(identifiers(parse(source, file)).filter((name) => GATED.has(name)))];
}

/** Names a file may reach the graph store by: useGraphStore, and every name
 * a module re-exports it under (`export { useGraphStore as useG }`,
 * `export const useG = useGraphStore`), so a re-exported hook counts. */
function storeNames(files: Array<{ file: string; source: string }>): Set<string> {
  const names = new Set(['useGraphStore']);
  for (let grown = true; grown;) {
    grown = false;
    for (const { file, source } of files) {
      const visit = (node: ts.Node) => {
        if (ts.isExportSpecifier(node) && names.has((node.propertyName ?? node.name).text) && !names.has(node.name.text)) {
          names.add(node.name.text); grown = true;
        }
        if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          for (const declaration of node.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isIdentifier(declaration.initializer)
              && names.has(declaration.initializer.text) && !names.has(declaration.name.text)) {
              names.add(declaration.name.text); grown = true;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parse(source, file));
    }
  }
  return names;
}

const READS_LOCK = /\buseCanvasLock\(|\brefuseCanvasEdit\(/;

/** Files that hand every control that acts to locked components (rendered
 * in round23Surfaces' SURFACES). */
const DELEGATES: Record<string, string> = {
  'components/cinema-studio/CinemaStudioView.tsx': 'its controls are CinemaShotsRail and CinemaShotPanel, which read the lock',
  'components/create-studio/CreateView.tsx': 'its controls are CreateComposer and ResultCard, which read the lock',
};

/** Files that name a gated action but have no control of their own that edits. */
const ALLOWLIST: Record<string, string> = {
  'lib/chatCanvasClear.ts': "the chat's /clear; ChatPanel refuses it with refuseCanvasEdit before calling",
  'lib/cinemaMotion.ts': "Send to motion's local node; called from CinemaShotPanel, whose Send to motion takes the lock",
  'lib/cinemaUploads.ts': "a Cinema reference upload writing its scene; started from CinemaSharedControls and CinemaShotPanel, whose attach and Retry buttons take the lock",
  'store/canvasProposalsStore.ts': "a proposal's Accept and its run; ProposalBar's buttons take the lock, the store gate refuses them, and Accept is fenced (proposal_canvas_replaced)",
  'store/uiStore.ts': "opening the trim editor makes or finds its edit node: VideoEditAction's button and EditNode's Open Editor take the lock; and selection changes; no control",
};

/** A JSX handler that may act. */
const HANDLER = /^on(Click|Change|KeyDown|KeyUp|Submit|Input|Drop|PointerDown|PointerUp|MouseDown|MouseUp|DoubleClick|Select|Blur)$/;
const CONTROL_TAGS = new Set(['button', 'input', 'select', 'textarea']);
/** An attribute that puts the control in the lock: lock.act / lock.mark / a
 * prop or variable named for it. */
const LOCK_ATTRIBUTE = /\block\b|\bcanvasLock\b|\blocked\b|\breadOnly\b|\bconfirm=\{/;

/** Review 23 G, review 1 of PR #200 L-5 G: in a file that reads the lock, a
 * control whose handler reaches a gated action (directly, or through the
 * file's own functions) must carry the lock itself or sit in an element
 * that does (a locked fieldset). A non-control element (a drag handle)
 * may refuse in its handler instead (refuseCanvasEdit). */
function unlockedControls(source: string, file: string): string[] {
  const root = parse(source, file);
  const locals = new Map<string, ts.Node>();
  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) locals.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) locals.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(root);
  const reach = (node: ts.Node, seen: Set<string>): Set<string> => {
    const names = new Set<string>();
    for (const name of identifiers(node)) {
      names.add(name);
      const local = locals.get(name);
      if (local && !seen.has(name)) { seen.add(name); for (const inner of reach(local, seen)) names.add(inner); }
    }
    return names;
  };
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties;
      const handlers = attributes.filter((attribute) => ts.isJsxAttribute(attribute) && HANDLER.test(attribute.name.getText(root)));
      const reached = new Set<string>();
      for (const handler of handlers) for (const name of reach(handler, new Set())) reached.add(name);
      const hits = [...reached].filter((name) => GATED.has(name));
      if (hits.length > 0) {
        const tag = node.tagName.getText(root);
        const own = attributes.some((attribute) => !(ts.isJsxAttribute(attribute) && HANDLER.test(attribute.name.getText(root)))
          && LOCK_ATTRIBUTE.test(attribute.getText(root)));
        let fenced = false;
        for (let up: ts.Node | undefined = node.parent; up && !fenced; up = up.parent) {
          if (ts.isJsxElement(up)) fenced = up.openingElement.attributes.properties.some((attribute) => LOCK_ATTRIBUTE.test(attribute.getText(root)));
        }
        const refusesInHandler = !CONTROL_TAGS.has(tag) && /^[a-z]/.test(tag) && (reached.has('refuseCanvasEdit') || reached.has('refuseEditWhileFollowing'));
        if (!own && !fenced && !refusesInHandler) {
          const { line } = root.getLineAndCharacterOfPosition(node.getStart(root));
          found.push(`${file}:${line + 1} <${tag}> ${hits.join(', ')}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Controls the check above finds that are covered another way (the reason). */
const CONTROL_ALLOWLIST: Record<string, string> = {
  'components/CommandPalette.tsx <input>': "the palette's search field: Enter runs the chosen command, and each command that edits is locked in buildCommands (round23Surfaces' CommandPalette)",
};

// Parsing every source file is slow under load: a generous limit.
describe('L-4: every file that reaches a gated action reads the canvas lock', { timeout: 120_000 }, () => {
  const files = walk(SRC, /\.tsx?$/).filter((path) => !path.endsWith('store/graphStore.ts'))
    .map((path) => ({ path, file: relative(SRC, path), source: readFileSync(path, 'utf8') }));
  const stores = storeNames(files);
  const reachesStore = (source: string, file: string) => identifiers(parse(source, file)).some((name) => stores.has(name));

  it('the scan sees every form review 23 and review 1 of PR #200 listed', () => {
    const forms: Record<string, string> = {
      A_selector: 'const run = useGraphStore((s) => s.executeGraph);',
      B_getState_alias: 'const graph = useGraphStore.getState(); graph.executeGraph();',
      C_destructure: 'const { executeGraph } = useGraphStore.getState();',
      D_shallow: 'useGraphStore(useShallow((s) => ({ run: s.executeGraph })));',
      E_bare_arrow: 'useGraphStore(s => s.executeGraph);',
      F_hook_destructure: 'const { executeGraph } = useGraphStore();',
      H_bracket: "const run = useGraphStore((s) => s['executeGraph']);",
      L_quote_before: 'const x = <button title="Don\'t" onClick={() => useGraphStore.getState().executeGraph()} />;',
      M_glob_in_string: 'const x = <input accept="image/*" />;\nconst run = useGraphStore((s) => s.executeGraph);\n/* a comment */',
    };
    for (const [form, line] of Object.entries(forms)) expect(gatedNames(line), form).toContain('executeGraph');
    expect(gatedNames('// undo the last step\nconst offer = \'redo\';')).toEqual([]);
    expect(gatedNames('/* executeGraph */ const label = "executeGraph";')).toEqual([]);
  });

  it('a re-exported store counts (J): a file that reaches it by another name is checked', () => {
    const fake = [
      { file: 'lib/storeAlias.ts', source: "export { useGraphStore as useG } from '../store/graphStore';" },
      { file: 'lib/storeAlias2.ts', source: "import { useG } from './storeAlias';\nexport const useH = useG;" },
    ];
    const names = storeNames(fake);
    expect([...names]).toEqual(expect.arrayContaining(['useGraphStore', 'useG', 'useH']));
  });

  it('each reads the lock, names its locked delegates, or is allowlisted with a reason', () => {
    const missing = files.flatMap(({ file, source }) => {
      if (!reachesStore(source, file)) return [];
      const uses = gatedNames(source, file);
      if (uses.length === 0) return [];
      if (READS_LOCK.test(source) || DELEGATES[file] || ALLOWLIST[file]) return [];
      return [`${file}: ${uses.join(', ')}`];
    });
    expect(missing).toEqual([]);
  });

  it('G: in a file that reads the lock, every control that reaches a gated action carries the lock', () => {
    const probe = 'const lock = useCanvasLock();\nconst run = useGraphStore((s) => s.executeGraph);\n'
      + 'export const A = () => <><button {...lock.act()} onClick={run}>Run</button><button onClick={() => run()}>New</button></>;';
    expect(unlockedControls(probe, 'probe.tsx')).toEqual(['probe.tsx:3 <button> executeGraph']);
    const found = files.filter(({ path, source }) => path.endsWith('.tsx') && READS_LOCK.test(source))
      .flatMap(({ file, source }) => unlockedControls(source, file))
      .filter((line) => !CONTROL_ALLOWLIST[line.replace(/:\d+ (<\w+>).*$/, ' $1')]);
    expect(found).toEqual([]);
  });

  it('the lists stay true: every entry still names a gated action, has a reason, and an allowlisted file has no lock to read', () => {
    for (const [file, reason] of Object.entries({ ...DELEGATES, ...ALLOWLIST })) {
      expect(reason.trim(), file).not.toBe('');
      const source = readFileSync(join(SRC, file), 'utf8');
      expect(gatedNames(source, file), `${file} no longer names a gated action: drop it from the list`).not.toEqual([]);
    }
  });

  it('review 23\'s two misses read the lock now, and EditNode\'s Open Editor (review 1 of PR #200, L-5)', () => {
    for (const file of ['components/editor/EditorView.tsx', 'components/panels/ChatPanel.tsx', 'components/video-editor/useRemotionKeyboard.ts',
      'components/nodes/EditNode.tsx']) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).toMatch(READS_LOCK);
    }
  });
});

// ── 2. GM r24 item 2 and PR #200 answer 6: one disabled colour treatment ──

const SHARED = 'styles/disabled-buttons.css';
/** A resting fill that reads as a filled button: the accent, danger, error,
 * the white of a white primary, or another solid colour (light, or clearly
 * coloured). Dark greys (#2a2a2a) and translucent surfaces are no fill. */
const FILL_TOKEN = /background(?:-color)?\s*:\s*var\(--(?:sr-accent|sr-error|sr-danger|sr-ink|sr-ink-bold|an-ink)\b/i;
function solidFill(body: string): boolean {
  if (FILL_TOKEN.test(body)) return true;
  const value = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim().toLowerCase() ?? '';
  if (/^white\b/.test(value)) return true;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})\b/.exec(value)?.[1];
  if (!hex) return false;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b) > 60 || (r + g + b) / 3 > 150;
}
/** A class that names a control a person presses. */
const BUTTONISH = /(?:button|btn|action|generate|send|download|start|export|render|cta|confirm|submit|apply|primary|open|save|new|back|danger|accept)\b/i;
/** Filled button-like classes the shared rule leaves alone, and why (the sweep list). */
const NOT_COVERED: Record<string, string> = {
  'commons-button': "the Commons' own light theme: a grey of white over its pale fill would vanish; it gets its own neutral in the app-wide sweep",
  'commons-button--primary': "the Commons' own light theme (as commons-button)",
};

function cssRules(css: string): Array<{ selector: string; body: string }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

/** The class a selector styles: its last compound's last class. */
function subjectClass(selector: string): string | null {
  const last = selector.replace(/:not\([^)]*\)/g, '').trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
  const classes = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  return classes.length ? classes[classes.length - 1] : null;
}

/** A rule's state: resting, or a state (hover, focus, disabled …). */
const STATE = /:(hover|focus|active|disabled|checked)|\[aria-(disabled|pressed|selected|checked|expanded)|\[data-|--selected|--active|::/;

function filledButtons(): Array<{ file: string; className: string }> {
  const found: Array<{ file: string; className: string }> = [];
  for (const path of walk(SRC, /\.css$/)) {
    const file = relative(SRC, path);
    if (file === SHARED) continue;
    for (const { selector, body } of cssRules(readFileSync(path, 'utf8'))) {
      if (!solidFill(body)) continue;
      for (const one of selector.split(',')) {
        // The legacy look (body:not(.app-slava-restraint)) is never shown.
        if (STATE.test(one) || /:not\(\.app-slava-restraint\)/.test(one)) continue;
        const className = subjectClass(one);
        if (className && BUTTONISH.test(className) && !NOT_COVERED[className]) found.push({ file, className });
      }
    }
  }
  return found;
}

/**
 * Disabled looks of their own, outside the shared file, that the app-wide
 * sweep still has to fold in (GM answer 6: "otherwise it goes on the sweep
 * list"). This list only shrinks: a new button style with a disabled look of
 * its own fails below until it is in the shared rule (or, with a reason, here).
 */
const SWEEP_LATER = new Set([
  'App.css: provider-recovery-status button',
  'components/agent-notes/agentNotes.css: agent-notes-btn',
  'styles/asset-move.css: asset-move__item',
  'styles/asset-move.css: asset-move__trigger',
  'styles/asset-proposals.css: asset-proposal__button',
  'styles/asset-trash.css: asset-trash__button',
  'styles/batch-node.css: batch-carousel button',
  'styles/canvas-next-steps.css: connection-popup__item',
  'styles/canvas-toolbar.css: toolbar__action',
  'styles/canvas-toolbar.css: toolbar__button',
  'styles/character-studio.css: character-def__ref-add',
  'styles/character-studio.css: character-palette__new',
  'styles/character-studio.css: character-rail__new',
  'styles/character-studio.css: character-test__run',
  'styles/chat-model-picker.css: chat-model-picker__trigger',
  'styles/commons-evaluation.css: evaluation-workspace button',
  'styles/commons.css: commons-button',
  'styles/commons.css: commons-fieldset button',
  'styles/commons.css: commons-link',
  'styles/create-gallery.css: create-composer button',
  'styles/create-gallery.css: result-card button',
  'styles/create-gallery.css: results-gallery button',
  'styles/moodboard-studio.css: moodboard-analysis button',
  'styles/moodboard-studio.css: moodboard-rail__new',
  'styles/nodes.css: model-node button',
  'styles/panels.css: chat-panel__connect-btn',
  'styles/panels.css: context-menu__item',
  'styles/paper-source-node.css: paper-source-node button',
  'styles/personal-agents.css: permission-card button',
  'styles/project-home.css: project-home button',
  'styles/prompt-dialog.css: prompt-dialog button',
  'styles/run-history.css: run-history button',
  'styles/run-history.css: run-history__action',
  'styles/run-history.css: run-history__replay',
  'styles/settings.css: settings-label__action',
  'styles/settings.css: settings-switch',
  'styles/settings.css: settings__button',
  'styles/slava-restraint.css: canvas-tabs__btn',
  'styles/slava-restraint.css: context-menu__item',
  'styles/slava-restraint.css: editor-transport__btn',
  'styles/slava-restraint.css: editor-transport__range',
  'styles/world-preview.css: world-modal__button',
]);

describe('GM r24 item 2 and PR #200 answer 6: a disabled button is neutral grey whatever the reason', () => {
  const shared = readFileSync(join(SRC, SHARED), 'utf8');
  const rules = cssRules(shared);
  const filledRule = rules.find(({ selector, body }) => /:disabled/.test(selector) && /background:\s*var\(--sr-disabled-fill/.test(body));
  const unfilledRule = rules.find(({ selector, body }) => /:disabled/.test(selector) && /background:\s*transparent/.test(body));
  // A modifier (`__button--primary`) is covered with its block's button (`__button`): both classes are on it.
  const covered = (className: string) => [className, className.replace(/--[\w-]+$/, '')].some((name) =>
    [filledRule, unfilledRule].some((rule) => new RegExp(`\\.${name}(?![\\w-])`).test(rule?.selector ?? '')));

  it('two rules, one colour: a grey fill for filled buttons, unfilled for ghost and outline; no accent; no extra opacity', () => {
    expect(filledRule).toBeDefined();
    expect(unfilledRule).toBeDefined();
    for (const rule of [filledRule!, unfilledRule!]) {
      expect(rule.body).not.toMatch(/--sr-accent|--sr-error|--sr-danger|#ff5a1f/i);
      expect(rule.selector).toMatch(/:disabled/);
      expect(rule.selector).toMatch(/\[aria-disabled=['"]?true/);
      expect(rule.body).toMatch(/opacity:\s*1\s*!important/);
      expect(rule.body).toMatch(/color:\s*var\(--sr-disabled-ink/);
    }
    // The unfilled rule comes first: a filled style wins for a button that has both classes.
    expect(shared.indexOf('background: transparent !important')).toBeLessThan(shared.indexOf('background: var(--sr-disabled-fill'));
  });

  it('it is loaded app-wide (App.tsx imports it, after the shared styles)', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).toMatch(/import '\.\/styles\/disabled-buttons\.css';/);
    expect(app.indexOf('disabled-buttons.css')).toBeGreaterThan(app.indexOf('slava-restraint.css'));
  });

  it('every filled button style is covered (accent, danger, white primaries, other solid fills)', () => {
    const found = filledButtons();
    expect(found.map((item) => item.className)).toEqual(expect.arrayContaining(['cinema-shot-panel__action--primary', 'create-composer__generate',
      'project-home__new', 'project-switch-toast__back', 'project-home__danger', 'prompt-dialog__danger', 'mask-painter__save']));
    const uncovered = found.filter(({ className }) => !covered(className));
    expect(uncovered.map(({ file, className }) => `${file}: .${className}`)).toEqual([]);
  });

  it('a new button style with a disabled look of its own fails until the shared rule covers it (the sweep list only shrinks)', () => {
    const own = new Set<string>();
    for (const path of walk(SRC, /\.css$/)) {
      const file = relative(SRC, path);
      if (file === SHARED) continue;
      for (const { selector, body } of cssRules(readFileSync(path, 'utf8'))) {
        if (!/opacity|color|background|border/.test(body)) continue;
        for (const one of selector.split(',')) {
          const state = one.replace(/:not\([^)]*\)/g, '');
          if (!/:disabled|\[aria-disabled/.test(state) || /:not\(\.app-slava-restraint\)/.test(one)) continue;
          // A bare `button:disabled` inside a block names the block.
          const subject = subjectClass(state);
          const bare = /(^|\s)button:disabled/.test(state) || /:is\(button/.test(state);
          const blocks = [...state.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
          const name = bare ? `${blocks[blocks.length - 1]?.replace(/__.*$/, '') ?? ''} button`.trim() : subject;
          if (!name || (!bare && (covered(name) || !BUTTONISH.test(name) && !/item|link|trigger|switch|range|preset|new|run|add/.test(name)))) continue;
          if (bare && blocks.length === 0) continue;
          own.add(`${file}: ${name}`);
        }
      }
    }
    const fresh = [...own].filter((entry) => !SWEEP_LATER.has(entry)).sort();
    expect(fresh, 'a disabled look outside styles/disabled-buttons.css').toEqual([]);
    const gone = [...SWEEP_LATER].filter((entry) => !own.has(entry)).sort();
    expect(gone, 'swept: drop these from SWEEP_LATER').toEqual([]);
  });

  it('no per-reason disabled look is left beside it (following or offline only)', () => {
    const perReason = walk(SRC, /\.css$/).flatMap((path) => cssRules(readFileSync(path, 'utf8'))
      .filter(({ selector, body }) => /\[data-(following|offline)-disabled\]/.test(selector) && /background/.test(body) && /generate|primary/.test(selector))
      .map(({ selector }) => `${relative(SRC, path)}: ${selector.replace(/\s+/g, ' ')}`));
    expect(perReason).toEqual([]);
  });
});
