import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
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

/** The source with comments and plain string literals blanked (template
 * literals stay: they hold code). "undo" in a comment, or 'redo' as a value,
 * is no call. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** Every gated action a file names, in any form. */
function gatedNames(source: string): string[] {
  const names = gatedGraphActions().join('|');
  return [...new Set([...code(source).matchAll(new RegExp(`\\b(${names})\\b`, 'g'))].map((m) => m[1]))];
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
  'lib/cinemaUploads.ts': "a Cinema reference upload writing its scene; started from CinemaSharedControls, which reads the lock",
  'store/canvasProposalsStore.ts': "a proposal's Accept and its run; ProposalBar's buttons take the lock, the store gate refuses them, and Accept is fenced (proposal_canvas_replaced)",
  'store/uiStore.ts': "opening the trim editor makes its edit node (VideoEditAction's button takes the lock), and selection changes; no control",
};

describe('L-4: every file that reaches a gated action reads the canvas lock', () => {
  const files = walk(SRC, /\.tsx?$/).filter((path) => !path.endsWith('store/graphStore.ts'));

  it('the scan sees every form review 23 listed', () => {
    const forms: Record<string, string> = {
      A_selector: 'const run = useGraphStore((s) => s.executeGraph);',
      B_getState_alias: 'const graph = useGraphStore.getState(); graph.executeGraph();',
      C_destructure: 'const { executeGraph } = useGraphStore.getState();',
      D_shallow: 'useGraphStore(useShallow((s) => ({ run: s.executeGraph })));',
      E_bare_arrow: 'useGraphStore(s => s.executeGraph);',
      F_hook_destructure: 'const { executeNode } = useGraphStore();',
    };
    for (const [form, line] of Object.entries(forms)) expect(gatedNames(line), form).not.toEqual([]);
    expect(gatedNames('// undo the last step\nconst offer = \'redo\';')).toEqual([]);
  });

  it('each reads the lock, names its locked delegates, or is allowlisted with a reason', () => {
    const missing = files.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      if (!/\buseGraphStore\b/.test(source)) return [];
      const uses = gatedNames(source);
      if (uses.length === 0) return [];
      const file = relative(SRC, path);
      if (READS_LOCK.test(source) || DELEGATES[file] || ALLOWLIST[file]) return [];
      return [`${file}: ${uses.join(', ')}`];
    });
    expect(missing).toEqual([]);
  });

  it('the lists stay true: every entry still names a gated action, has a reason, and an allowlisted file has no lock to read', () => {
    for (const [file, reason] of Object.entries({ ...DELEGATES, ...ALLOWLIST })) {
      expect(reason.trim(), file).not.toBe('');
      const source = readFileSync(join(SRC, file), 'utf8');
      expect(gatedNames(source), `${file} no longer names a gated action: drop it from the list`).not.toEqual([]);
    }
  });

  it('review 23\'s two misses read the lock now', () => {
    for (const file of ['components/editor/EditorView.tsx', 'components/panels/ChatPanel.tsx', 'components/video-editor/useRemotionKeyboard.ts']) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).toMatch(READS_LOCK);
    }
  });
});

// ── 2. GM r24 item 2: one disabled rule ─────────────────────────────────────

const SHARED = 'styles/disabled-buttons.css';
const ACCENT_FILL = /background(?:-color)?\s*:[^;]*(?:--sr-accent\b|--sr-error\b|--sr-danger\b|#ff5a1f\b)/i;
/** A class that names a control a person presses. */
const BUTTONISH = /(?:button|btn|action|generate|send|download|start|export|render|cta|confirm|submit|apply|primary|open)\b/i;
/** Accent-filled button-like classes that are no button (and why). */
const NOT_BUTTONS: Record<string, string> = {};

function cssRules(css: string): Array<{ selector: string; body: string }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

/** The class a selector styles: its last compound's last class. */
function subjectClass(selector: string): string | null {
  const last = selector.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
  const classes = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  return classes.length ? classes[classes.length - 1] : null;
}

function accentFilledButtons(): Array<{ file: string; className: string }> {
  const found: Array<{ file: string; className: string }> = [];
  for (const path of walk(SRC, /\.css$/)) {
    const file = relative(SRC, path);
    if (file === SHARED) continue;
    for (const { selector, body } of cssRules(readFileSync(path, 'utf8'))) {
      if (!ACCENT_FILL.test(body)) continue;
      for (const one of selector.split(',')) {
        // A hover, focus, active or disabled state is not the resting fill.
        if (/:(hover|focus|active|disabled)|\[aria-disabled|\[data-(following|offline)-disabled/.test(one)) continue;
        const className = subjectClass(one);
        if (className && BUTTONISH.test(className) && !NOT_BUTTONS[className]) found.push({ file, className });
      }
    }
  }
  return found;
}

describe('GM r24 item 2: a disabled button is neutral grey whatever the reason', () => {
  const shared = readFileSync(join(SRC, SHARED), 'utf8');
  const disabledRule = cssRules(shared).find(({ body }) => /background/.test(body) && /var\(--sr-surface-control/.test(body));

  it('the shared rule is neutral: the control surface, the plain edge, the light ink, no accent', () => {
    expect(disabledRule).toBeDefined();
    expect(disabledRule!.body).not.toMatch(/--sr-accent|--sr-error|--sr-danger|#ff5a1f/i);
    expect(disabledRule!.selector).toMatch(/:disabled/);
    expect(disabledRule!.selector).toMatch(/\[aria-disabled=['"]?true/);
  });

  it('it is loaded app-wide (App.tsx imports it, after the shared styles)', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).toMatch(/import '\.\/styles\/disabled-buttons\.css';/);
    expect(app.indexOf('disabled-buttons.css')).toBeGreaterThan(app.indexOf('slava-restraint.css'));
  });

  it('every accent-filled button style is covered by it (Cinema\'s Generate shot, Create\'s Generate and the rest)', () => {
    const found = accentFilledButtons();
    expect(found.map((item) => item.className)).toEqual(expect.arrayContaining(['cinema-shot-panel__action--primary', 'create-composer__generate']));
    const uncovered = found.filter(({ className }) => !new RegExp(`\\.${className}\\b`).test(disabledRule!.selector));
    expect(uncovered.map(({ file, className }) => `${file}: .${className}`)).toEqual([]);
  });

  it('no per-reason disabled look is left beside it (following or offline only)', () => {
    const perReason = walk(SRC, /\.css$/).flatMap((path) => cssRules(readFileSync(path, 'utf8'))
      .filter(({ selector, body }) => /\[data-(following|offline)-disabled\]/.test(selector) && ACCENT_FILL.test(body) === false
        && /background/.test(body) && /generate|primary/.test(selector))
      .map(({ selector }) => `${relative(SRC, path)}: ${selector.replace(/\s+/g, ' ')}`));
    expect(perReason).toEqual([]);
  });
});
