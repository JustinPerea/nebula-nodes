// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDeclarations, parseRules, stripComments } from '../scripts/lib/css-scan.mjs';

/**
 * Design: the two evaluation panes' look is one rule. Every colour in commons-evaluation.css and
 * commons-review.css comes from the --evaluation-* tokens defined once in the `.commons-evaluation`
 * rule, and each of those tokens is a single --sr-* token. A later change to the panes' look is a
 * change to that one rule, so a colour literal anywhere else fails here.
 */

const STYLES = join(__dirname, '../src/styles');

const NAMED = [
  'white', 'black', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey', 'silver',
  'maroon', 'olive', 'lime', 'aqua', 'cyan', 'teal', 'navy', 'fuchsia', 'magenta', 'brown', 'gold', 'coral',
  'crimson', 'indigo', 'violet', 'salmon', 'tomato', 'khaki', 'ivory', 'beige', 'tan', 'plum', 'orchid',
  'lavender', 'turquoise', 'azure', 'snow', 'linen', 'wheat', 'rebeccapurple',
];
const NAMED_RE = new RegExp(`(?<![\\w-])(?:${NAMED.join('|')})(?![\\w-])`, 'i');
const LITERAL_RES: Array<[string, RegExp]> = [
  ['hex colour', /#[0-9a-f]{3,8}\b/i],
  ['rgb()/rgba()', /\brgba?\(/i],
  ['hsl()/hsla()', /\bhsla?\(/i],
  ['named colour', NAMED_RE],
];

type Hit = { selector: string; decl: string; reason: string };

function isTokenRule(selector: string, body: string): boolean {
  return selector === '.commons-evaluation' && /--evaluation-/.test(body);
}

function check(css: string): Hit[] {
  const hits: Hit[] = [];
  for (const rule of parseRules(stripComments(css))) {
    const tokenRule = isTokenRule(rule.selector, rule.body);
    for (const { prop, value } of parseDeclarations(rule.body, rule.bodyStart)) {
      const decl = `${prop}:${value}`;
      if (tokenRule && prop.startsWith('--evaluation-')) {
        if (!/^var\(--sr-[\w-]+\)$/.test(value)) {
          hits.push({ selector: rule.selector, decl, reason: 'a token value must be a single var(--sr-*)' });
        }
        continue;
      }
      // Strip var(...) so a token's own name (--sr-ink-white) is not read as a colour.
      const bare = value.replace(/var\(\s*--[\w-]+/gi, 'var(');
      for (const [reason, re] of LITERAL_RES) {
        if (re.test(bare)) hits.push({ selector: rule.selector, decl, reason });
      }
    }
  }
  return hits;
}

describe('the evaluation panes\' look is one rule (design: every colour reads a token)', () => {
  it('catches a hex colour in a rule', () => {
    expect(check('.commons-evaluation { --evaluation-ground:var(--sr-canvas); }\n.evaluation-form { background:#eff1e8; }')).toHaveLength(1);
  });

  it('catches an rgba track', () => {
    expect(check('.review-grade meter { background:rgba(255,255,255,.08); }')).toHaveLength(1);
  });

  it('catches a named colour', () => {
    expect(check('.evaluation-marker { color:white; border:1px solid black; }')).toHaveLength(2);
  });

  it('catches a literal token value in the token rule', () => {
    expect(check('.commons-evaluation { --evaluation-ground:#1c211d; --evaluation-ink:var(--sr-ink); }')).toHaveLength(1);
    expect(check('.commons-evaluation { --evaluation-ink:var(--sr-ink), red; }')).toHaveLength(1);
  });

  it('passes tokens, transparent and var() names that contain a colour word', () => {
    expect(check('.commons-evaluation { --evaluation-ground:var(--sr-canvas); }\n.x { color:var(--evaluation-ink); background:transparent; border-color:var(--sr-ink-white); }')).toEqual([]);
  });

  for (const file of ['commons-evaluation.css', 'commons-review.css']) {
    it(`${file} has no colour literal outside the token rule`, () => {
      expect(check(readFileSync(join(STYLES, file), 'utf8'))).toEqual([]);
    });
  }

  it('the real token rule defines tokens, so the check is not vacuous', () => {
    const css = stripComments(readFileSync(join(STYLES, 'commons-evaluation.css'), 'utf8'));
    const rule = parseRules(css).find((r: { selector: string; body: string }) => isTokenRule(r.selector, r.body));
    expect(rule).toBeTruthy();
    const tokens = parseDeclarations(rule!.body, rule!.bodyStart).filter((d: { prop: string }) => d.prop.startsWith('--evaluation-'));
    expect(tokens.length).toBeGreaterThan(30);
  });
});
