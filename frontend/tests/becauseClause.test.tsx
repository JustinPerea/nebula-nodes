/**
 * Failure lines in the because form (design, error-copy round 5): "Nebula couldn’t ‹do X› because ‹reason›."
 * One table of reasons (REASON_CLAUSES) and one test line per row, so changing a row's words is a one-line edit
 * here and in lib/errorCopy. Also: the status rows, the sentence rule, the apostrophe limits, the headings
 * failedWhat can't read (each one deliberate), the colour exceptions and FailureLines rendering one line.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FailureLines } from '../src/components/failure/FailureLines';
import { LineText } from '../src/components/LineText';
import {
  ACCESS_LOST_COPY, BACKEND_NOT_RUNNING_COPY, CONNECTION_LOST_COPY, ConnectionLostError, FailureNotice, NEBULA_NOT_ANSWERING_COPY,
  NO_RESPONSE_COPY, PERSON_REQUIRED_APP_COPY, PERSON_REQUIRED_COPY, PERSON_REQUIRED_DEV_COPY, REASON_CLAUSES, REFUSED_FALLBACK_COPY,
  RequestFailedError, TOO_LARGE_COPY, becauseLine, besideButton, clauseFor, curlApostrophes, failedWhat, failureCopy, failureMessage,
  foldApostrophes, overProjectLimitCopy,
} from '../src/lib/errorCopy';
import { nodeErrorCopy } from '../src/lib/nodeErrorCopy';
import { resetLinesForTests } from '../src/lib/notConnectedLine';
import { headingSites } from './helpers/headingSites';

afterEach(() => { cleanup(); resetLinesForTests(); });

interface Row { reason: string; heading: string; alone: string; button?: string }

/** One line per table row: the old reason, a heading over it and the whole line, alone and beside a button. */
const TABLE_ROWS: Row[] = [
  { reason: "That reference isn't there anymore. Reload to get the latest references.", heading: "Couldn't load this reference.",
    alone: 'Nebula couldn’t load this reference because it isn’t there anymore. Reload to get the latest references.' },
  { reason: "That reference isn't in this held-out set. Reload to get the latest references.", heading: "Couldn't load this reference.",
    alone: 'Nebula couldn’t load this reference because it isn’t in this held-out set. Reload to get the latest references.' },
  { reason: "Those filters didn't work. Clear them and try again.", heading: "Couldn't load the references.",
    alone: 'Nebula couldn’t load the references because those filters didn’t work. Clear them and try again.' },
  { reason: 'not found', heading: "Couldn't load the image.", alone: 'Nebula couldn’t load the image because the file isn’t there anymore.' },
  { reason: 'invalid UI session token', heading: "Couldn't load the references.",
    alone: 'Nebula couldn’t load the references because this tab’s session ended. Reload to sign in again.' },
  { reason: 'no UI session: open Nebula from the desktop app or use the dev link', heading: "Couldn't load the references.",
    alone: 'Nebula couldn’t load the references because this tab’s session ended. Reload to sign in again.' },
  { reason: 'only the human UI session can do this', heading: "Couldn't seal the labels.",
    alone: 'Nebula couldn’t seal the labels because this tab isn’t signed in as you. Reload to sign in again.' },
  { reason: 'Nebula can’t read that file type. Use JPG, PNG, WebP, GIF, HEIC, MP4 or MOV.', heading: "Couldn't upload “clip.avi”.",
    alone: 'Nebula couldn’t upload “clip.avi” because it isn’t a file type Nebula reads. Use JPG, PNG, WebP, GIF, HEIC, MP4 or MOV.' },
  { reason: 'That file couldn’t be read. It may be damaged.', heading: "Couldn't upload “a.png”.",
    alone: 'Nebula couldn’t upload “a.png” because the file couldn’t be read. It may be damaged.' },
  { reason: 'That collection isn’t there anymore. Reload to get the latest collections.', heading: "Couldn't upload “a.png”.",
    alone: 'Nebula couldn’t upload “a.png” because the collection isn’t there anymore. Reload to get the latest collections.' },
  { reason: 'Nebula can’t read that folder. Check that it exists and that Nebula can open it.', heading: "Couldn't prepare the folder.",
    alone: 'Nebula couldn’t prepare the folder because the folder can’t be read. Check that it exists and that Nebula can open it.' },
  { reason: 'That setting isn’t available. Reload to get the latest settings.', heading: "Couldn't save the setting.",
    alone: 'Nebula couldn’t save the setting because the setting isn’t available anymore. Reload to get the latest settings.' },
  { reason: 'That value doesn’t work for this setting. Reload to get the latest settings.', heading: "Couldn't save the setting.",
    alone: 'Nebula couldn’t save the setting because the setting doesn’t take that value. Reload to get the latest settings.' },
];

describe('REASON_CLAUSES', () => {
  it('has a line here for every row, and no row without one', () => {
    const covered = new Set(TABLE_ROWS.map((row) => foldApostrophes(row.reason)));
    const keys = new Set([...REASON_CLAUSES.keys()].map(foldApostrophes));
    expect([...keys].filter((key) => !covered.has(key))).toEqual([]);
    expect([...covered].filter((key) => !keys.has(key))).toEqual([]);
  });

  it.each(TABLE_ROWS.map((row) => [row.reason, row] as const))('%s', (_reason, row) => {
    const status = 404;
    expect(becauseLine({ heading: row.heading, reason: row.reason, status }, 'alone')).toBe(row.alone);
    expect(becauseLine({ heading: row.heading, reason: row.reason, status }, 'button')).toBe(row.button ?? row.alone);
    // The backend writes curly apostrophes; a key written either way matches.
    expect(becauseLine({ heading: row.heading, reason: foldApostrophes(row.reason) }, 'alone')).toBe(row.alone);
  });
});

describe('the status rows', () => {
  const heading = "Couldn't save the project.";
  const cases: [string, string, number | undefined, string, string][] = [
    ['no answer', CONNECTION_LOST_COPY, 0, 'the server isn’t answering. Check that Nebula is running, then try again.', 'the server isn’t answering. Try again.'],
    ['Nebula not answering', NEBULA_NOT_ANSWERING_COPY, undefined, 'the server isn’t answering. Check that Nebula is running, then try again.', 'the server isn’t answering. Try again.'],
    ['backend not running', BACKEND_NOT_RUNNING_COPY, undefined, 'the server isn’t running. Start Nebula, then reload.', 'the server isn’t running. Start Nebula, then reload.'],
    ['a gateway', NO_RESPONSE_COPY, 504, 'the server didn’t respond. Try again.', 'the server didn’t respond. Try again.'],
    ['a rate limit', NO_RESPONSE_COPY, 429, 'the server is busy. Try again in a moment.', 'the server is busy. Try again.'],
    ['a server error', NO_RESPONSE_COPY, 500, 'the server hit an error. Try again.', 'the server hit an error. Try again.'],
    ['no access', ACCESS_LOST_COPY, 403, 'you don’t have access to this anymore. Reload to sign in again.', 'you don’t have access to this anymore. Reload to sign in again.'],
    ['a refusal with no reason', REFUSED_FALLBACK_COPY, 400, 'the server didn’t accept it. Try again, or reload if it keeps happening.', 'the server didn’t accept it. Try again.'],
    ['too large', TOO_LARGE_COPY, 413, 'it’s too large.', 'it’s too large.'],
  ];
  it.each(cases)('%s', (_name, reason, status, alone, button) => {
    expect(becauseLine({ heading, reason, status }, 'alone')).toBe(`Nebula couldn’t save the project because ${alone}`);
    expect(becauseLine({ heading, reason, status }, 'button')).toBe(`Nebula couldn’t save the project because ${button}`);
    expect(clauseFor({ reason, status }, 'alone')).toBe(alone);
    expect(clauseFor(reason, 'button')).toBe(clauseFor({ reason, status: undefined }, 'button'));
  });

  it('reads an error’s own status and heading', () => {
    const error = new RequestFailedError("Couldn't rename the project.", 429);
    expect(error.message).toBe('Nebula couldn’t rename the project because the server is busy. Try again in a moment.');
    expect(error.heading).toBe("Couldn't rename the project.");
    expect(error.reason).toBe(NO_RESPONSE_COPY);
    expect(clauseFor(error, 'button')).toBe('the server is busy. Try again.');
    const lost = new ConnectionLostError(new TypeError('Failed to fetch'), { heading: "Couldn't load the character." });
    expect(lost.message).toBe('Nebula couldn’t load the character because the server isn’t answering. Check that Nebula is running, then try again.');
    expect(lost.reason).toBe(CONNECTION_LOST_COPY);
    expect(failureCopy(lost, { short: true }).reason).toBe('Nebula couldn’t load the character because the server isn’t answering. Try again.');
    const notice = new FailureNotice("Couldn't delete the project.", 'A run is still going. Let it finish or stop it.');
    expect(notice.message).toBe('Nebula couldn’t delete the project because a run is still going. Let it finish or stop it.');
  });

  it('turns a line already in the because form into the button’s', () => {
    expect(besideButton('Nebula couldn’t save the project because the server isn’t answering. Check that Nebula is running, then try again.'))
      .toBe('Nebula couldn’t save the project because the server isn’t answering. Try again.');
    expect(besideButton('Nebula couldn’t save the brief because the server is busy. Try again in a moment.'))
      .toBe('Nebula couldn’t save the brief because the server is busy. Try again.');
    expect(besideButton('Nebula couldn’t do it because a run is still going.')).toBe('Nebula couldn’t do it because a run is still going.');
  });
});

describe('the pattern rows and the sentence rule', () => {
  const lines: [string, string, string][] = [
    ["Couldn't delete the note.", 'That note isn’t there anymore. Reload to get the latest notes.',
      'Nebula couldn’t delete the note because it isn’t there anymore. Reload to get the latest notes.'],
    ["Couldn't restore the moodboard.", 'That board isn’t in Recently deleted anymore. Reload to get the latest list.',
      'Nebula couldn’t restore the moodboard because it isn’t in Recently deleted anymore. Reload to get the latest list.'],
    ["Couldn't create the project.", overProjectLimitCopy(501, 500, 2),
      'Nebula couldn’t create the project because you have 501 projects and the limit is 500. You can make a new one after you delete 2 projects.'],
    ["Couldn't delete the project.", 'A run is still going. Let it finish or stop it.',
      'Nebula couldn’t delete the project because a run is still going. Let it finish or stop it.'],
    ["Couldn't load your projects.", 'Your disk is full. Free up some space, then try again.',
      'Nebula couldn’t load your projects because your disk is full. Free up some space, then try again.'],
    ["Couldn't start the run.", 'It couldn’t save its run safeguards. Restart Nebula, then try again.',
      'Nebula couldn’t start the run because it couldn’t save its run safeguards. Restart Nebula, then try again.'],
    ["Couldn't load the models.", 'The server is out of date. Restart Nebula, then try again.',
      'Nebula couldn’t load the models because the server is out of date. Restart Nebula, then try again.'],
    ["Couldn't save the character.", 'It changed in another tab. Reload to get the latest version.',
      'Nebula couldn’t save the character because it changed in another tab. Reload to get the latest version.'],
    ['Nebula couldn’t start the run.', 'Krea’s style images and their strength have no BytePlus equivalent. Remove the style images, or run this on Krea.',
      'Nebula couldn’t start the run because Krea’s style images and their strength have no BytePlus equivalent. Remove the style images, or run this on Krea.'],
    ['Nebula couldn’t start the run.', 'A World Labs node can’t run once for each item of a Batch. Give each its own node.',
      'Nebula couldn’t start the run because a World Labs node can’t run once for each item of a Batch. Give each its own node.'],
    ["Couldn't refresh the source.", 'Paper can’t find the object. Link it again.',
      'Nebula couldn’t refresh the source because Paper can’t find the object. Link it again.'],
    ["Couldn't open the Paper artwork.", 'Paper Desktop didn’t open it. Use “Open source link”.',
      'Nebula couldn’t open the Paper artwork because Paper Desktop didn’t open it. Use “Open source link”.'],
  ];
  it.each(lines)('%s %s', (heading, reason, line) => {
    expect(becauseLine({ heading, reason })).toBe(line);
  });

  it('has no "because" when the reason is only an instruction, and none when it is unknown', () => {
    expect(becauseLine({ heading: 'Nebula couldn’t start the run.', reason: 'Pick one of the node’s output formats, then run the node again.' }))
      .toBe('Nebula couldn’t start the run. Pick one of the node’s output formats, then run the node again.');
    expect(clauseFor('Pick another size.')).toBeNull();
    expect(clauseFor('')).toBeNull();
    expect(becauseLine({ heading: "Couldn't load your projects.", reason: '' })).toBe('Nebula couldn’t load your projects.');
  });

  it('puts a reason that names its own failure in the heading’s place', () => {
    expect(becauseLine({ heading: "Couldn't stop the reply.", reason: "Couldn't stop the reply. The agent isn't answering." }))
      .toBe('Nebula couldn’t stop the reply because the agent isn’t answering.');
    expect(becauseLine({ heading: "Couldn't run the node.", reason: 'Couldn’t download the result from Krea. Its download link may have expired. Run the node again.' }))
      .toBe('Nebula couldn’t download the result from Krea because its download link may have expired. Run the node again.');
    expect(becauseLine({ heading: "Couldn't open the project.", reason: 'Nebula couldn’t delete it because it is open.' }))
      .toBe('Nebula couldn’t delete it because it is open.');
    expect(becauseLine({ heading: "Couldn't run the graph.", reason: "Couldn't reach the provider. Check your connection." }))
      .toBe('Nebula couldn’t run the graph. Couldn’t reach the provider. Check your connection.');
  });

  it('shows a person refusal in the not-connected form', () => {
    const heading = "Couldn't delete the project for good.";
    expect(becauseLine({ heading, reason: PERSON_REQUIRED_COPY }))
      .toBe('Nebula couldn’t delete the project for good because this tab isn’t connected as you. Open the link Nebula printed when it started.');
    expect(becauseLine({ heading, reason: PERSON_REQUIRED_APP_COPY }))
      .toBe('Nebula couldn’t delete the project for good because this window isn’t connected as you. Quit Nebula and open it again.');
    expect(becauseLine({ heading, reason: PERSON_REQUIRED_DEV_COPY }))
      .toBe('Nebula couldn’t delete the project for good because this window isn’t connected as you. The notice below says why.');
  });
});

describe('curlApostrophes', () => {
  it('curls an apostrophe only between two letters', () => {
    expect(curlApostrophes("It's Krea's and don't")).toBe('It’s Krea’s and don’t');
    expect(curlApostrophes("'quoted' words")).toBe("'quoted' words");
    expect(curlApostrophes("the users' files")).toBe("the users' files");
  });

  it('never changes a file name, an id, a path, code or a quoted name', () => {
    expect(curlApostrophes("Couldn't read dusk's.png")).toBe("Couldn’t read dusk's.png");
    expect(curlApostrophes("photo 3's copy")).toBe("photo 3's copy");
    expect(curlApostrophes("shot 2's frame")).toBe("shot 2's frame");
    expect(curlApostrophes("/Users/o'brien/Krea's/x")).toBe("/Users/o'brien/Krea's/x");
    expect(curlApostrophes('C:\\Users\\o\'brien')).toBe('C:\\Users\\o\'brien');
    expect(curlApostrophes("node_7's id")).toBe("node_7's id");
    expect(curlApostrophes('“don\'t” and "can\'t" and `isn\'t`')).toBe('“don\'t” and "can\'t" and `isn\'t`');
    expect(curlApostrophes("Don't touch “Krea's” file.txt's")).toBe("Don’t touch “Krea's” file.txt's");
  });

  it('applies to a backend reason used as a clause, and to the action', () => {
    expect(becauseLine({ heading: "Couldn't read Krea's page.", reason: "The page isn't Krea's own file 3's.pdf." }))
      .toBe("Nebula couldn’t read Krea’s page because the page isn’t Krea’s own file 3's.pdf.");
    expect(failedWhat("Couldn't upload “it's.png”.")).toBe("upload “it's.png”");
  });
});

describe('failedWhat', () => {
  it('reads the action from a heading, with either apostrophe', () => {
    expect(failedWhat("Couldn't load the character.")).toBe('load the character');
    expect(failedWhat('Nebula couldn’t save “a.b”.')).toBe('save “a.b”');
    expect(failedWhat('Nebula couldn’t start the run.')).toBe('start the run');
    expect(failedWhat("Couldn't clear the canvas. Nothing was removed.")).toBeNull();
    expect(failedWhat("Couldn't load this moodboard")).toBeNull();
    expect(failedWhat('Save failed')).toBeNull();
  });

  // Every heading in the app's source that failedWhat can't read. Each is deliberate: the line keeps its heading
  // and reason as they are. A new one fails here, so it is named before it ships.
  const KNOWN_MISSES = [
    'components/agent-notes/agentRosterModel.ts | Agents',
    'lib/lockPlacement.ts | h1, h2, h3, h4, h5, h6, [role="heading"]',
    'lib/nodeErrorCopy.ts | Waiting for you to run it',
    'lib/personThread.test.ts | x',
    'lib/settingsNotice.ts | Nebula couldn’t dismiss this notice',
  ];
  it('lists every heading it cannot read', () => {
    const sites = headingSites();
    expect(sites.length).toBeGreaterThan(200);
    const misses = [...new Set(sites.filter((site) => failedWhat(site.heading) === null).map((site) => `${site.file} | ${site.heading}`))].sort();
    expect(misses).toEqual(KNOWN_MISSES);
  });
});

describe('colour', () => {
  const line = 'Nebula couldn’t save the project because the server didn’t respond. Try again.';

  it('draws a because failure neutral and keeps the warning colour for tone="failure"', () => {
    const { container } = render(<><p data-testid="a"><LineText text={line} /></p><p data-testid="b"><LineText text={line} tone="failure" /></p></>);
    expect(container.querySelector('[data-testid="a"]')?.hasAttribute('data-line-because')).toBe(true);
    expect(container.querySelector('[data-testid="b"]')?.hasAttribute('data-line-because')).toBe(false);
  });

  it('marks a line with no reason too, and leaves a line that is not a failure alone', () => {
    const { container } = render(<><p data-testid="a"><LineText text="Nebula couldn’t load your projects." /></p>
      <p data-testid="b"><LineText text="Saved." /></p></>);
    expect(container.querySelector('[data-testid="a"]')?.hasAttribute('data-line-because')).toBe(true);
    expect(container.querySelector('[data-testid="b"]')?.hasAttribute('data-line-because')).toBe(false);
  });

  it('keeps the warning colour through FailureLines', () => {
    const { container } = render(<FailureLines failure={failureCopy(new RequestFailedError("Couldn't run the graph.", 500))} tone="failure" />);
    expect(container.querySelector('[data-line-because]')).toBeNull();
  });
});

describe('FailureLines', () => {
  it('renders one sentence in one LineText', () => {
    const error = new RequestFailedError("Couldn't save the board.", 504);
    const { container } = render(<FailureLines failure={failureCopy(error)} />);
    expect(container.querySelectorAll('.failure-lines__reason')).toHaveLength(1);
    expect(container.querySelector('.failure-lines__heading')).toBeNull();
    expect(container.textContent).toBe('Nebula couldn’t save the board because the server didn’t respond. Try again.');
  });

  it('ends in "Try again." beside a button of its own', () => {
    const { container } = render(<FailureLines failure={failureCopy(new ConnectionLostError(new TypeError('x'), { heading: "Couldn't load the character." }))} retry />);
    expect(container.textContent).toBe('Nebula couldn’t load the character because the server isn’t answering. Try again.');
  });

  it('keeps a heading line only for a notice that is not a failure', () => {
    const { container } = render(<FailureLines failure={{ heading: 'Waiting for you to run it', reason: 'Idol needs you.' }} />);
    expect(container.querySelector('.failure-lines__heading')?.textContent).toBe('Waiting for you to run it');
  });

  it('turns a hand-made heading and reason into one line', () => {
    const { container } = render(<FailureLines failure={{ heading: "Couldn't analyze this reference.", reason: 'The analysis service didn’t respond. Try again.' }} />);
    expect(container.textContent).toBe('Nebula couldn’t analyze this reference because the analysis service didn’t respond. Try again.');
  });

  it('gives failureCopy’s parts: the single line, the action, the bare reason, the button ending', () => {
    const copy = failureCopy(new RequestFailedError("Couldn't rename the project.", 429));
    expect(copy.heading).toBe('');
    expect(copy.reason).toBe('Nebula couldn’t rename the project because the server is busy. Try again in a moment.');
    expect(copy.what).toBe('rename the project');
    expect(copy.cause).toBe(NO_RESPONSE_COPY);
    expect(copy.button).toBe('Nebula couldn’t rename the project because the server is busy. Try again.');
    expect(failureMessage(new RequestFailedError("Couldn't rename the project.", 429), "Couldn't x."))
      .toBe('Nebula couldn’t rename the project because the server is busy. Try again in a moment.');
    expect(failureMessage(new TypeError('boom'), "Couldn't open the file.")).toBe(
      'Nebula couldn’t open the file because the server didn’t accept it. Try again, or reload if it keeps happening.');
  });
});

describe('a node’s run failure names the provider where it is known', () => {
  const run = (category: string, provider?: string) => nodeErrorCopy({ raw: 'raw text', category, friendly: 'The API key was rejected.', provider }).reason;
  it('says the provider’s name, and "the provider" only as the fallback', () => {
    expect(run('auth', 'OpenAI')).toBe('Nebula couldn’t run the node because OpenAI rejected the API key. Check your OpenAI API key in Settings.');
    expect(run('auth')).toBe('Nebula couldn’t run the node because the provider rejected the API key. Check your key for this provider in Settings.');
    expect(run('network', 'OpenAI')).toBe('Nebula couldn’t run the node because OpenAI isn’t answering. Check your connection, then try again.');
    expect(run('blocked', 'Krea')).toBe('Nebula couldn’t run the node because Krea’s safety filter blocked the request. Try rephrasing your prompt or removing flagged content.');
    expect(run('quota', 'Krea')).toBe('Nebula couldn’t run the node because Krea’s quota or credits are used up. Check your plan or billing with Krea.');
    expect(run('rate_limit', 'Krea')).toBe('Nebula couldn’t run the node because Krea is limiting requests. Wait a moment, then run it again.');
    expect(run('timeout')).toBe('Nebula couldn’t run the node because the provider took too long to respond. Try again.');
    expect(run('invalid_input', 'Krea')).toBe('Nebula couldn’t run the node because Krea rejected the request as invalid. Check the node’s inputs and settings.');
  });

  it('says no reason when none is known, and keeps a notice that waits for the person under its heading', () => {
    expect(nodeErrorCopy({ raw: 'x', category: 'unknown', provider: 'Krea' }).reason)
      .toBe('Nebula couldn’t run the node. Run it again. If it keeps failing, “Details” shows what Krea said.');
    expect(nodeErrorCopy({ raw: 'x', category: 'unknown', surface: 'shot' }).reason)
      .toBe('Nebula couldn’t generate the shot. Generate it again. If it keeps failing, open “Details”.');
    const waiting = nodeErrorCopy({ category: 'waiting', person: 'Idol needs you to run it.' });
    expect(waiting.heading).toBe('Waiting for you to run it');
    expect(waiting.reason).toBe('Idol needs you to run it.');
  });
});
