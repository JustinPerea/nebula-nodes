/**
 * PR #204 round 10 (review 8 LOW-1): the runtime ratchet (tests/helpers/bareLines.ts, run after
 * every test by tests/setup.ts) catches each form the source scan missed, F1-F6, and passes the
 * same words rendered through <LineText>, the notice's own words and an agent's quoting them.
 */
import { createElement, useEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { LineText } from '../src/components/LineText';
import { notConnectedBecause, personRequiredCopy } from '../src/lib/errorCopy';
import { resetLinesForTests } from '../src/lib/notConnectedLine';
import { takeBareLines } from './helpers/bareLines';

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
afterEach(() => { cleanup(); resetLinesForTests(); });

/** Renders, lets the observer run, and returns what it saw (taken, so this test passes). */
async function seen(ui: React.ReactElement): Promise<string[]> {
  takeBareLines();
  render(ui);
  await settle();
  return takeBareLines();
}

function Banner({ message }: { message: string }) { return <p>{message}</p>; }
function Setter() {
  const [line, setLine] = useState('');
  // A state setter in a later callback, the form F5 names.
  useEffect(() => { const timer = setTimeout(() => setLine(personRequiredCopy()), 0); return () => clearTimeout(timer); }, []);
  return <p>{line}</p>;
}

describe('review 8 LOW-1: each bypass form is caught at run time', () => {
  const line = notConnectedBecause('save', false);
  const forms: [string, () => React.ReactElement][] = [
    ['F1 a local const', () => { const msg = line; return <p>{msg}</p>; }],
    ['F2 a prop handed on', () => <Banner message={line} />],
    ['F3 literal JSX text', () => <p>Nebula couldn’t save because this tab isn’t connected as you. Open the link.</p>],
    ['F4 createElement', () => createElement('p', null, line)],
    ['F5 a state setter', () => <Setter />],
    ['F6 a join', () => <p>{['Couldn’t save.', line].join(' ')}</p>],
  ];
  for (const [name, ui] of forms) {
    it(name, async () => {
      expect((await seen(ui())).length, name).toBe(1);
    });
  }

  it('the same words through LineText, the notice\'s own and an agent\'s quote pass', async () => {
    expect(await seen(<>
      <p><LineText text={line} /></p>
      <span className="label"><LineText text={line} className="own" /></span>
      <div className="person-required">{personRequiredCopy()}</div>
      <p className="agent-note-card__text" data-agent-text="">{`The tab said: “${line}”`}</p>
    </>)).toEqual([]);
  });
});
