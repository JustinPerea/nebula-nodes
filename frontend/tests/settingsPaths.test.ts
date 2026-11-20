/**
 * Every "Settings > ..." path in the app's copy names a tab and a section that exist.
 *
 * Copy reaches the person from two places: the frontend (string literals and JSX text under frontend/src) and the
 * backend (string literals under backend/**\/*.py: node readiness lines, chat refusals, CLI and MCP text). Agents read
 * paths too: the markdown they are given (docs/, skills/, .claude/skills/, .agents/skills/, backend/**\/*.md, the
 * repo's top-level notes) and the CLI package (nebula/). All are read as text, comments and docstrings included, so a
 * path written anywhere is held to the same names.
 *
 * A path is read as a person reads it: one that wraps across consecutive comment lines is joined, doubled spaces and
 * non-breaking spaces count as one space, and a name must have the real name's case ("Personal Agents" is wrong).
 *
 * The real names come from the Settings components: the tabs from SettingsTabs.tsx, and each tab's sections from the
 * headings (<h3>/<h4>) and folder labels of the files that tab renders. A path may start at a tab ("Settings >
 * Preferences > Personal agents") or at a section ("Settings > Personal agents"); below a tab it must name a section of
 * that tab, and below a section only one of its own subsections. Under Providers the next name is a provider's label.
 *
 * Not Nebula's Settings, so not checked: another app's own menu ("Control UI > Settings > MCP", "Claude menu >
 * Settings > Developer"), which has a name before it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROVIDER_LABELS } from '../src/lib/directRoute';

const FRONTEND = join(__dirname, '..');
const SETTINGS = join(FRONTEND, 'src/components/panels/settings');
const BACKEND = join(FRONTEND, '..', 'backend');

type Node = { name: string; children: Node[] };

/** The names a heading shows: every quoted literal in it, else its text up to "·" or a "{". */
export function headingNames(source: string): string[] {
  const names: string[] = [];
  for (const heading of source.matchAll(/<h([34])\b[^>]*>([\s\S]*?)<\/h\1>/g)) {
    const inner = heading[2].replace(/<label[^>]*>|<\/label>/g, '');
    const quoted = [...inner.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    if (quoted.length > 0) { names.push(...quoted); continue; }
    const plain = inner.replace(/&amp;/g, '&').split(/[·{]/)[0].trim();
    if (plain && !plain.startsWith('<')) names.push(plain);
  }
  for (const label of source.matchAll(/<FolderField\b[^>]*\blabel="([^"]+)"/g)) names.push(label[1]);
  return names;
}

const read = (file: string) => readFileSync(join(SETTINGS, file), 'utf8');
const node = (name: string, children: Node[] = []): Node => ({ name, children });

/** The Settings tree, from the components. A tab's sections come from the files it renders. */
export function settingsTree(): Node[] {
  const tabs = [...read('SettingsTabs.tsx').matchAll(/\{ id: '(\w+)', label: '([^']+)' \}/g)].map((m) => ({ id: m[1], label: m[2] }));
  const files: Record<string, string[]> = {
    providers: ['ProvidersTab.tsx'],
    preferences: ['PreferencesTab.tsx', 'AgentSpendSection.tsx', 'PersonalAgentsSection.tsx'],
    storage: ['StorageTab.tsx'],
  };
  return tabs.map((tab) => {
    const sections = (files[tab.id] ?? []).flatMap((file) => headingNames(read(file)))
      .map((name) => node(name, name === 'Agent spending' ? headingNames(read('ConnectedApps.tsx')).map((n) => node(n)) : []));
    const providers = tab.id === 'providers' ? Object.values(PROVIDER_LABELS).map((label) => node(label)) : [];
    return node(tab.label, [...sections, ...providers]);
  });
}

/** Foreign menus: "Control UI > Settings > MCP", "Claude menu > Settings > Developer" belong to other apps. */
const FOREIGN_MENU = /(?:>|\bmenu|\bUI)\s*$/;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The longest known name that opens `text` (on a word boundary), among `names`; undefined when none does. */
function opening(text: string, names: readonly string[]): string | undefined {
  return [...names].sort((a, b) => b.length - a.length)
    .find((name) => new RegExp(`^${escape(name)}(?![\\p{L}\\p{N}])`, 'u').test(text));
}

export type BadPath = { path: string; why: string };

const COMMENT_LINE = /^\s*(?:\/\/+|#+|\*(?!\/)|\/\*+|<!--)/;
const COMMENT_MARKER = /^\s*(?:\/\/+|#+|\*(?!\/)|\/\*+|<!--)[ \t]?/;

/** Two string literals written one after the other ("a" "b", the Python way), or joined with a "+" ('a' + 'b', the
 * JS way, the "+" at the end of a line or the start of the next): the quotes and what sits between them go, so
 * the words are one run, as the person sees them. An f or r prefix on the second literal goes with it. */
const ADJACENT_LITERALS = /(["'])[ \t]*(?:\r?\n[ \t]*)?(?:\+[ \t]*(?:\r?\n[ \t]*)?)?[fr]?(["'])/g;

/** The text as a person reads it: string literals written side by side or joined with "+" made one, consecutive
 * comment lines joined into one line (the way check-internal-ids joins them), a path that breaks after its ">" (or
 * opens the next line with one) joined, and runs of spaces made one. */
export function readAsProse(text: string): string {
  const lines = text.replace(/\u00a0/g, ' ').replace(ADJACENT_LITERALS, '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const last = out.length - 1;
    if (last >= 0 && COMMENT_LINE.test(out[last]) && COMMENT_LINE.test(line)) out[last] = `${out[last].trimEnd()} ${line.replace(COMMENT_MARKER, '').trim()}`;
    else out.push(line);
  }
  return out.join('\n')
    .replace(/>[ \t]*\n[ \t]*(?:(?:\/\/+|#+|\*(?!\/))[ \t]*)?(?=\S)/g, '> ')
    .replace(/(\bSettings(?: >[ \t]*[^\n>.,;:()"'`<]+?)*)[ \t]*\n[ \t]*(?:(?:\/\/+|#+|\*(?!\/))[ \t]*)?>/g, '$1 >')
    .replace(/[ \t]{2,}/g, ' ');
}

/** The longest known name that opens `text` when case is ignored: the real name written in another case. */
function openingAnyCase(text: string, names: readonly string[]): string | undefined {
  return [...names].sort((a, b) => b.length - a.length)
    .find((name) => new RegExp(`^${escape(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text));
}

/** Each "Settings > ..." path in `text` that names a tab or section the Settings don't have. */
export function badSettingsPaths(source: string, tree: readonly Node[] = settingsTree()): BadPath[] {
  const text = readAsProse(source);
  const bad: BadPath[] = [];
  const everySection = (nodes: readonly Node[]): Node[] => nodes.flatMap((n) => [n, ...everySection(n.children)]);
  const sections = tree.flatMap((tab) => tab.children.filter((c) => !Object.values(PROVIDER_LABELS).includes(c.name)).flatMap((c) => everySection([c])));
  for (const start of text.matchAll(/\bSettings >[ \t]+(?=\S)/g)) {
    if (FOREIGN_MENU.test(text.slice(Math.max(0, start.index - 12), start.index))) continue;
    let rest = text.slice(start.index + start[0].length);
    const used: string[] = [];
    let level: readonly Node[] = [];
    let first = true;
    for (;;) {
      const pool = first ? [...tree, ...sections] : [...level];
      const name = opening(rest, pool.map((n) => n.name));
      if (name === undefined) {
        const cased = openingAnyCase(rest, pool.map((n) => n.name));
        if (cased !== undefined) {
          bad.push({ path: `Settings > ${[...used, rest.slice(0, cased.length)].join(' > ')}`, why: `the name is "${cased}", in that case` });
          break;
        }
        const seen = (/^[^\n.,;:()"'`<>]+/.exec(rest)?.[0] ?? '').trim();
        // A path that stops where its prose does ("Settings > Providers and add a key") has no unknown name.
        const known = used.length > 0 || !/^[A-Z]/.test(seen);
        if (!known || first || /^[A-Z]/.test(seen)) bad.push({ path: `Settings > ${[...used, seen].join(' > ')}`, why: first ? 'not a tab or a section' : `not a section of ${used[used.length - 1]}` });
        break;
      }
      used.push(name);
      const hit = pool.find((n) => n.name === name)!;
      level = hit.children;
      rest = rest.slice(name.length);
      first = false;
      const next = /^ > +(?=\S)/.exec(rest);
      if (!next) break;
      rest = rest.slice(next[0].length);
    }
  }
  return bad;
}

/** Dated notes (docs/notes/): each records what the copy said when it was written, the old text in its before columns
 * included, so a path in one is history, not a claim about today's Settings. Everything else in docs/ is read. */
const HISTORY = /[\\/]docs[\\/]notes[\\/]/;

function files(dir: string, ext: RegExp, skip: RegExp, history?: RegExp): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (skip.test(path) || history?.test(path + '/')) return [];
    return statSync(path).isDirectory() ? files(path, ext, skip, history) : ext.test(entry) ? [path] : [];
  });
}

describe('the Settings tree is read from the components', () => {
  it('has the three tabs and the sections the copy points at', () => {
    const tree = settingsTree();
    expect(tree.map((t) => t.name)).toEqual(['Providers', 'Preferences', 'Storage']);
    const preferences = tree.find((t) => t.name === 'Preferences')!;
    for (const name of ['Runs', 'Canvas', 'Agent', 'Personal agents', 'Agent spending']) expect(preferences.children.map((c) => c.name)).toContain(name);
    expect(preferences.children.find((c) => c.name === 'Agent spending')!.children.map((c) => c.name)).toContain('Connect your agent');
    expect(tree.find((t) => t.name === 'Storage')!.children.map((c) => c.name)).toContain('Help & advanced');
  });
});

describe('badSettingsPaths', () => {
  it('accepts a right path, from a tab or from a section, and a provider under Providers', () => {
    for (const text of [
      'Turn it on in Settings > Preferences > Personal agents.',
      'Sign in from Settings > Personal agents, then send again.',
      'Make a token in Settings > Connect your agent.',
      'Add it in Settings > Providers, or choose another.',
      'Open Settings > Providers > Krea in Nebula.',
      'the key saved in Settings > Providers > Google · Gemini API (GOOGLE_API_KEY)',
      'Set it in Settings > Preferences: the limits.',
      'See Settings > Preferences > Agent spending > Connect your agent.',
    ]) expect(badSettingsPaths(text), text).toEqual([]);
  });

  it('skips another app\'s own Settings menu', () => {
    expect(badSettingsPaths('open Control UI > Settings > MCP > Add server')).toEqual([]);
    expect(badSettingsPaths('Claude menu > Settings > Developer > Edit Config opens the file.')).toEqual([]);
  });

  it('fails a wrong tab', () => {
    expect(badSettingsPaths('Change it in Settings > Interface.')).toEqual([{ path: 'Settings > Interface', why: 'not a tab or a section' }]);
    expect(badSettingsPaths('See Settings > Run cost)')).toHaveLength(1);
  });

  it('fails a wrong section under a real tab', () => {
    expect(badSettingsPaths('Open Settings > Preferences > Run cost.')).toEqual([{ path: 'Settings > Preferences > Run cost', why: 'not a section of Preferences' }]);
    expect(badSettingsPaths('Open Settings > Storage > Personal agents.')).toHaveLength(1);
    expect(badSettingsPaths('Open Settings > Providers > Personal agents.')).toHaveLength(1);
  });

  it('fails a real section under the wrong parent', () => {
    expect(badSettingsPaths('Open Settings > Connect your agent > Personal agents.')).toHaveLength(1);
  });
});

describe('badSettingsPaths reads a path the way a person does', () => {
  it('reads a path wrapped across comment lines', () => {
    expect(badSettingsPaths('// Turn it on in Settings > Preferences >\n// Run cost, then send again.'))
      .toEqual([{ path: 'Settings > Preferences > Run cost', why: 'not a section of Preferences' }]);
    expect(badSettingsPaths('# Open Settings >\n# Interface.')).toEqual([{ path: 'Settings > Interface', why: 'not a tab or a section' }]);
    expect(badSettingsPaths('/**\n * See Settings > Preferences >\n * Personal agents.\n */')).toEqual([]);
    expect(badSettingsPaths('// Open Settings\n// > Preferences > Run cost.')).toHaveLength(1);
  });

  it('fails a segment whose case differs from the real name', () => {
    expect(badSettingsPaths('Open Settings > Preferences > Personal Agents.')).toEqual([{ path: 'Settings > Preferences > Personal Agents', why: 'the name is "Personal agents", in that case' }]);
    expect(badSettingsPaths('Open Settings > preferences > personal agents.')).toHaveLength(1);
    expect(badSettingsPaths('Add a key in Settings > providers.')).toHaveLength(1);
    expect(badSettingsPaths('Open Settings > Preferences > Personal agents.')).toEqual([]);
  });

  it('reads a path split across string literals, written side by side or joined with +', () => {
    const wrong = [{ path: 'Settings > Preferences > Run cost', why: 'not a section of Preferences' }];
    expect(badSettingsPaths('x = "Open Settings > Preferences > " "Run cost."')).toEqual(wrong);
    expect(badSettingsPaths('x = ("Open Settings > Preferences > "\n     "Run cost.")')).toEqual(wrong);
    expect(badSettingsPaths("const t = 'Open Settings > Preferences > ' + 'Run cost.';")).toEqual(wrong);
    expect(badSettingsPaths('const t = "Open Settings > Preferences > " +\n  "Run cost.";')).toEqual(wrong);
    expect(badSettingsPaths('const t = "Open Settings > Preferences > "\n  + "Run cost.";')).toEqual(wrong);
    expect(badSettingsPaths('x = f"Open Settings > Preferences > " f"Run cost."')).toEqual(wrong);
    // A right path split the same ways is still right.
    expect(badSettingsPaths('x = "Open Settings > Preferences > " "Personal agents."')).toEqual([]);
    expect(badSettingsPaths("const t = 'Open Settings > ' + 'Providers.';")).toEqual([]);
    // Nothing else is joined: a literal and a name, or two separate statements, stay apart.
    expect(badSettingsPaths('a = "Settings > Providers"\nb = "Run cost"')).toEqual([]);
  });

  it('reads doubled spaces as one', () => {
    expect(badSettingsPaths('Open Settings  >  Preferences >  Personal  agents.')).toEqual([]);
    expect(badSettingsPaths('Open Settings  >  Preferences >  Run  cost.')).toHaveLength(1);
    expect(badSettingsPaths('Open Settings\u00a0>\u00a0Preferences >\u00a0Run cost.')).toHaveLength(1);
  });
});

describe('every Settings path in the app\'s copy names a tab and a section that exist', () => {
  const skip = /node_modules|[\\/]\.venv|[\\/]venv[\\/]|[\\/]tests?[\\/]|__pycache__|\.test\.|[\\/]dist[\\/]/;
  const ROOT = join(FRONTEND, '..');
  const exists = (dir: string) => { try { return statSync(dir).isDirectory(); } catch { return false; } };
  // Agent-facing markdown: the docs, every skills folder, the backend's own notes and the repo's top-level files.
  const markdownDirs = ['docs', 'skills', '.claude/skills', '.agents/skills'].map((d) => join(ROOT, d)).filter(exists);
  const topLevel = readdirSync(ROOT).filter((f) => /\.md$/.test(f)).map((f) => join(ROOT, f));
  const sources = [
    ...files(join(FRONTEND, 'src'), /\.(ts|tsx)$/, skip),
    ...files(BACKEND, /\.(py|md)$/, skip),
    ...files(join(ROOT, 'nebula'), /\.py$/, skip),
    ...markdownDirs.flatMap((dir) => files(dir, /\.md$/, skip, HISTORY)),
    ...topLevel,
  ];

  it('reads the frontend and the backend', () => {
    expect(sources.some((f) => f.endsWith('ChatModelPicker.tsx'))).toBe(true);
    expect(sources.some((f) => f.endsWith('personal_agents.py'))).toBe(true);
    expect(sources.length).toBeGreaterThan(300);
  });

  it('also reads what agents read: docs, skills and the CLI package', () => {
    for (const tail of [join('docs', 'CHAT-SETUP.md'), join('skills', 'nebula', 'SKILL.md'), join('commons', 'skill.md'), join('nebula', '__main__.py')]) {
      expect(sources.some((f) => f.endsWith(tail)), tail).toBe(true);
    }
    expect(sources.some((f) => f.includes(join('.claude', 'skills')))).toBe(true);
  });

  it('has no wrong path', () => {
    const tree = settingsTree();
    const wrong = sources.flatMap((file) => badSettingsPaths(readFileSync(file, 'utf8'), tree)
      .map((bad) => `${relative(join(FRONTEND, '..'), file)}: ${bad.path} (${bad.why})`));
    expect(wrong).toEqual([]);
  });
});
