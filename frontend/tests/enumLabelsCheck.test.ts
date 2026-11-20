// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findEnumLabelHits } from '../scripts/check-enum-labels.mjs';

/**
 * scripts/check-enum-labels.mjs runs in `npm run lint` (design: a person never reads a stored
 * value; "You" leads a line, "you" sits mid-sentence). `bad` must be caught, `fine` must pass.
 */
const bad: Array<[string, string]> = [
  ['an option showing its value', `const a = <option key={role} value={role}>{role}</option>;`],
  ['an option showing its value, spread over lines', `const a = (<option value={v}>\n  {v}\n</option>);`],
  ['a valueless option showing an expression', `const a = <option key={role}>{role}</option>;`],
  ['a valueless option showing a call', `const a = <option key={role}>{String(role)}</option>;`],
  ['a literal "by You" in JSX text', `const a = <p>Added by You</p>;`],
  ['a literal "by You" in a string', `const a = 'Added by You';`],
  ['a literal "by You" in a template', 'const a = `Added by You on ${d}`;'],
  ['the leading form after "by" in JSX', `const a = <p>Added by {actorLabel(m.actor)}</p>;`],
  ['the leading form after "by" in a template', 'const a = `Added by ${actorLabel(actor)}`;'],
  ['an option whose text is String(value)', `const a = <option value={role}>{String(role)}</option>;`],
  ['an option whose text is a template holding only the value', 'const a = <option value={role}>{`${role}`}</option>;'],
  ['an option whose value and text differ by parentheses and a cast', `const a = <option value={role as Role}>{(role)}</option>;`],
  ['the leading form after "by" and a {\' \'} spacer', `const a = <p>Added by{' '}{actorLabel(m.actor)}</p>;`],
  ['the leading form after "by" and a line break', `const a = <p>Added by\n  {actorLabel(m.actor)}</p>;`],
  ['the leading form through a member callee', `const a = <p>Added by {fmt.actorLabel(m.actor)}</p>;`],
  ['the leading form in a concatenation', `const a = 'Added by ' + actorLabel(m.actor);`],
  ['a badge showing an element access by a string', `const a = <span className="commons-badge">{s['state']}</span>;`],
  ['a badge with a lower-case string literal child', `const a = <span className="commons-badge">{'inbox'}</span>;`],
  ['a badge with a conditional of lower-case strings', `const a = <span className="commons-badge">{x ? 'queued' : 'held'}</span>;`],
  ['a badge with one lower-case conditional branch', `const a = <span className="commons-badge">{x ? 'Queued' : 'held'}</span>;`],
  ['a badge with a property access inside a child element', `const a = <span className="commons-badge"><b>{s.state}</b></span>;`],
  ['a badge with a property access inside a fragment', `const a = <span className="commons-badge"><>{s.state}</></span>;`],
  ['a badge with an element access inside a child element', `const a = <span className="commons-badge"><b>{s['state']}</b></span>;`],
  ['a badge whose first content is lower-case text before a count', `const a = <span className="commons-badge">items {n}</span>;`],
  ['a badge with a lower-case literal before a number', `const a = <span className="commons-badge">{'items '}{n}</span>;`],
  ['a badge with lower-case text',  `const a = <span className="commons-badge commons-badge--inbox">inbox</span>;`],
  ['a badge showing a stored value', 'const a = <span className={`commons-badge commons-badge--${s.state}`}>{s.state}</span>;'],
  ['a badge showing a property access', `const a = <span className="commons-badge">{s.source_kind}</span>;`],
  ['a badge showing a cast value', `const a = <span className="commons-badge">{r.status as string}</span>;`],
  ['a badge with an element access through a dynamic key then a property', `const a = <span className="commons-badge">{row[field].value}</span>;`],
  ['a badge with an indexed array then a property', `const a = <span className="commons-badge">{s.tags[0].name}</span>;`],
  ['a badge with a property of a non-label call', `const a = <span className="commons-badge">{get(s).state}</span>;`],
  ['a badge with a method call on a stored access', `const a = <span className="commons-badge">{s.state.toLowerCase()}</span>;`],
  ['a badge with a dynamic element access', `const a = <span className="commons-badge">{row[field]}</span>;`],
  ['a badge with a template whose head is lower case', 'const a = <span className="commons-badge">{`inbox ${n}`}</span>;'],
  ['a badge with a stored value on the left of ??', `const a = <span className="commons-badge">{s.state ?? 'Unknown'}</span>;`],
  ['a badge with a stored value on the right of ||', `const a = <span className="commons-badge">{label || s.state}</span>;`],
  ['a badge with a lower-case literal on the right of ??', `const a = <span className="commons-badge">{label ?? 'unknown'}</span>;`],
  ['a badge with a stored value after &&', `const a = <span className="commons-badge">{ok && s.state}</span>;`],
  ['a badge with lower-case text leading inside a child element', `const a = <span className="commons-badge"><b>hi</b></span>;`],
];
const fine: Array<[string, string]> = [
  ['an option labelled through a map', `const a = <option key={role} value={role}>{ROLE_LABELS[role]}</option>;`],
  ['an option labelled by a helper', `const a = <option key={v} value={v}>{enumValueLabel(key, v)}</option>;`],
  ['an option with literal text', `const a = <option value="image">Image</option>;`],
  ['a valueless option with literal text', `const a = <option>Any</option>;`],
  ['a valueless option with a placeholder text and no expression', `const a = <option disabled>Choose one…</option>;`],
  ['an id and a name', `const a = <option key={c.id} value={c.id}>{c.name}</option>;`],
  ['the mid-sentence form', `const a = <p>Added by {actorLabel(m.actor, { midSentence: true })}</p>;`],
  ['the leading form where a name leads', `const a = <span>{actorLabel(c.actor)}</span>;`],
  ['trash actorLabel on a by object', 'const a = ` by ${actorLabel(by)}`;'],
  ['trash actorLabel on a pinnedBy object', 'const a = actorLabel(choices.pinnedBy);'],
  ['"you" lower-case', `const a = <p>Added by you</p>;`],
  ['"You" leading a sentence', `const a = <p>You added this</p>;`],
  ['the mid-sentence form through a member callee', `const a = <p>Added by {fmt.actorLabel(m.actor, { midSentence: true })}</p>;`],
  ['the mid-sentence form in a concatenation', `const a = 'Added by ' + actorLabel(m.actor, { midSentence: true });`],
  ['a concatenation not after "by"', `const a = 'Name: ' + actorLabel(m.actor);`],
  ['a badge with a label map lookup', `const a = <span className="commons-badge">{ROLE_LABELS[role]}</span>;`],
  ['a badge with a helper call', 'const a = <span className={`commons-badge commons-badge--${s}`}>{sourceKindLabel(s.source_kind)}</span>;'],
  ['a badge with a capitalised literal', `const a = <span className="commons-badge commons-badge--inbox">Inbox</span>;`],
  ['a badge with a count in a template', 'const a = <span className="commons-badge">{`${n} ✎`}</span>;'],
  ['text after a number in a badge', `const a = <span className="commons-badge">{n} items</span>;`],
  ['text after a number in a source badge', `const a = <span className="commons-source">{n} images</span>;`],
  ['a plain identifier count', `const a = <span className="commons-badge">{count}</span>;`],
  ['a source badge showing a plain identifier', 'const a = <span className={`commons-source commons-source--${kind}`}>{label}</span>;'],
  ['a plain identifier label', `const a = <span className="commons-badge">{label}</span>;`],
  ['a capitalised string literal child', `const a = <span className="commons-badge">{'Inbox'}</span>;`],
  ['a conditional of capitalised strings', `const a = <span className="commons-badge">{x ? 'Queued' : 'Held'}</span>;`],
  ['a conditional of label map lookups', `const a = <span className="commons-badge">{x ? LABELS[a] : LABELS[b]}</span>;`],
  ['a child element with a capitalised literal', `const a = <span className="commons-badge"><b>Inbox</b></span>;`],
  ['a child element with a call', `const a = <span className="commons-badge"><b>{label(s.state)}</b></span>;`],
  ['a property of a map lookup', `const a = <span className="commons-badge">{MAP[s.state]!.label}</span>;`],
  ['a map lookup by an identifier key', `const a = <span className="commons-badge">{LABELS[s.state]}</span>;`],
  ['a property of a label-map lookup with a non-null assertion', `const a = <span className="commons-badge">{SIGHTING_STATE[s.state]!.label}</span>;`],
  ['a property of a badge call', `const a = <span className="commons-badge">{analysisBadge(x).label}</span>;`],
  ['a property of a label call', `const a = <span className="commons-badge">{enumValueLabel(f, v).length}</span>;`],
  ['a label call with ?? and a capitalised fallback', `const a = <span className="commons-badge">{enumValueLabel(f, v) ?? 'Unknown'}</span>;`],
  ['a count after &&', `const a = <span className="commons-badge">{ok && count}</span>;`],
  ['a template with a capitalised head', 'const a = <span className="commons-badge">{`Inbox ${n}`}</span>;'],
  ['lower-case text on an element that is no badge', `const a = <span className="commons-meta">inbox</span>;`],
];

describe('check-enum-labels', () => {
  it.each(bad)('fails %s', (_name, source) => {
    expect(findEnumLabelHits(source)).toHaveLength(1);
  });
  it.each(fine)('passes %s', (_name, source) => {
    expect(findEnumLabelHits(source)).toEqual([]);
  });
});
