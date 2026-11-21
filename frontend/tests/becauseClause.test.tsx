/**
 * Failure lines in the because form (design, error-copy): "Nebula couldn’t ‹do X› because ‹reason›."
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
  couldntLine, endedSentence, foldApostrophes, isBecauseFailure, isLoadLine, oneLine, overProjectLimitCopy,
} from '../src/lib/errorCopy';
import { nodeErrorCopy } from '../src/lib/nodeErrorCopy';
import { createWhileFollowingLine, runWhileFollowingLine } from '../src/lib/canvasFollow';
import { quoted } from '../src/lib/quoted';
import { handoffFailedLine } from '../src/lib/savingCutOff';
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
    ['a refusal with no reason', REFUSED_FALLBACK_COPY, 400, 'the server didn’t accept it. Try again, or reload the page if it keeps happening.', 'the server didn’t accept it. Try again.'],
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

const PATTERN_LINES: [string, string, string][] = [
  ["Couldn't delete the note.", 'That note isn’t there anymore. Reload to get the latest notes.',
    'Nebula couldn’t delete the note because it isn’t there anymore. Reload to get the latest notes.'],
  ["Couldn't restore the moodboard.", 'That board isn’t in Recently deleted anymore. Reload to get the latest list.',
    'Nebula couldn’t restore the moodboard because it isn’t in Recently deleted anymore. Reload to get the latest list.'],
  ["Couldn't upload “big.mov”.", 'File exceeds 500 MB limit',
    'Nebula couldn’t upload “big.mov” because it’s over the 500 MB limit.'],
  ["Couldn't upload “big.mov”.", 'File exceeds 250 MB limit.',
    'Nebula couldn’t upload “big.mov” because it’s over the 250 MB limit.'],
  ["Couldn't upload “big.png”.", 'Image exceeds 20 MB limit',
    'Nebula couldn’t upload “big.png” because it’s over the 20 MB limit.'],
  ["Couldn't upload “big.pdf”.", 'Document exceeds 20 MB limit',
    'Nebula couldn’t upload “big.pdf” because it’s over the 20 MB limit.'],
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

describe('the pattern rows and the sentence rule', () => {
  const lines = PATTERN_LINES;
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

  it('a reason that ends inside a quote or a bracket is a finished sentence, with no second full stop', () => {
    expect(becauseLine({ heading: 'Couldn’t save “x”.', reason: 'File is huge (max 5 MB.)' }))
      .toBe('Nebula couldn’t save “x”. File is huge (max 5 MB.)');
    expect(becauseLine({ heading: 'Couldn’t run the node.', reason: 'OpenAI said “try later.”' }))
      .toBe('Nebula couldn’t run the node because OpenAI said “try later.”');
  });

  it('a reason that names the thing the heading calls by its kind is the same failure', () => {
    expect(becauseLine({ heading: 'Couldn’t save the project.', reason: 'Nebula couldn’t save “Harbor” because the disk is full.' }))
      .toBe('Nebula couldn’t save “Harbor” because the disk is full.');
    expect(becauseLine({ heading: 'Couldn’t delete “World”.', reason: 'Nebula couldn’t delete “world” because it is open.' }))
      .toBe('Nebula couldn’t delete “world” because it is open.');
    // A different thing under the same verb keeps the heading.
    expect(becauseLine({ heading: 'Couldn’t save the project.', reason: 'Nebula couldn’t save its World Labs safeguards. Restart Nebula, then try again.' }))
      .toBe('Nebula couldn’t save the project. Nebula couldn’t save its World Labs safeguards. Restart Nebula, then try again.');
  });

  it('an empty clause is no clause', () => {
    expect(becauseLine({ heading: 'Couldn’t save “x”.', reason: '', clause: ' ' })).toBe('Nebula couldn’t save “x”.');
  });

  it('puts a reason that names its own failure in the heading’s place', () => {
    expect(becauseLine({ heading: "Couldn't stop the reply.", reason: "Couldn't stop the reply. The agent isn't answering." }))
      .toBe('Nebula couldn’t stop the reply because the agent isn’t answering.');
    expect(becauseLine({ heading: "Couldn't run the node.", reason: 'Couldn’t download the result from Krea. Its download link may have expired. Run the node again.' }))
      .toBe('Nebula couldn’t download the result from Krea because its download link may have expired. Run the node again.');
    expect(becauseLine({ heading: "Couldn't delete it.", reason: 'Nebula couldn’t delete it because it is open.' }))
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
    // The label of the "heading" region role (ROLE_LABELS), not a line's heading.
    'extraction/read.ts | Heading',
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
  // The scan parses every source file; CI shares its cores, so the default 5 s is too short.
  }, 60_000);
});

describe('colour', () => {
  const line = 'Nebula couldn’t save the project because the server didn’t respond. Try again.';

  it('draws a because failure neutral and keeps the warning colour for tone="failure"', () => {
    const { container } = render(<><p data-testid="a"><LineText text={line} /></p><p data-testid="b"><LineText text={line} tone="failure" /></p></>);
    expect(container.querySelector('[data-testid="a"]')?.hasAttribute('data-line-because')).toBe(true);
    expect(container.querySelector('[data-testid="b"]')?.hasAttribute('data-line-because')).toBe(false);
  });

  it('marks a line told tone="because" whatever its words, so an agent named "Hermes v2.0" reads neutral', () => {
    const { container } = render(<><p data-testid="a"><LineText text="Hermes v2.0 stopped because boom." tone="because" /></p>
      <p data-testid="b"><LineText text="Hermes v2.0 stopped because boom." /></p></>);
    expect(container.querySelector('[data-testid="a"]')?.hasAttribute('data-line-because')).toBe(true);
    expect(container.querySelector('[data-testid="b"]')?.hasAttribute('data-line-because')).toBe(false);
  });

  it('draws tone="warning" in the warning ink even on a not-connected line, which tone="failure" leaves neutral', () => {
    const line = 'This tab isn’t connected as you, so it can’t start a chat. Open the link Nebula printed when it started, then send again.';
    const { container } = render(<><p data-testid="a"><LineText text={line} tone="warning" /></p>
      <p data-testid="b"><LineText text={line} tone="failure" /></p><p data-testid="c"><LineText text="Claude stopped because boom." tone="warning" /></p></>);
    expect(container.querySelector('[data-testid="a"]')?.hasAttribute('data-line-because')).toBe(false);
    expect(container.querySelector('[data-testid="b"]')?.hasAttribute('data-line-because')).toBe(true);
    expect(container.querySelector('[data-testid="c"]')?.hasAttribute('data-line-because')).toBe(false);
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
      'Nebula couldn’t open the file because the server didn’t accept it. Try again, or reload the page if it keeps happening.');
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

describe('a quoted name in a heading is read whole', () => {
  const upload = (name: string) => `Couldn’t upload ${quoted(name)}.`;
  const lost = (name: string) => `Nebula couldn’t upload ${quoted(name)} because the server didn’t respond. Try again.`;

  it.each(["Bob's photo.png", 'scan 2. final.png', 'shot.', "it's. a. file.png", 'Bob’s_file', "Bob's.sketch"])('%s', (name) => {
    expect(failedWhat(upload(name))).toBe(`upload ${quoted(name)}`);
    expect(becauseLine({ heading: upload(name), reason: NO_RESPONSE_COPY, status: 503 })).toBe(lost(name));
  });
});

describe('a reason that is not a clause is not put after “because”', () => {
  const big = 'Couldn’t upload “big.mov”.';
  it.each([
    ['File is too small to be a valid media file', 'Nebula couldn’t upload “big.mov”. File is too small to be a valid media file.'],
    ['Source file not found', 'Nebula couldn’t upload “big.mov”. Source file not found.'],
    ['Empty request body.', 'Nebula couldn’t upload “big.mov”. Empty request body.'],
    // A name or a quoted name, a {} slot, a lead word and a digit still follow "because".
    ['OpenAI rejected the key.', 'Nebula couldn’t upload “big.mov” because OpenAI rejected the key.'],
    ['ElevenLabs is out of credits.', 'Nebula couldn’t upload “big.mov” because ElevenLabs is out of credits.'],
    ['Krea’s limit is 20 MB.', 'Nebula couldn’t upload “big.mov” because Krea’s limit is 20 MB.'],
    ['“Shot 2” is still running.', 'Nebula couldn’t upload “big.mov” because “Shot 2” is still running.'],
    ['The file is damaged.', 'Nebula couldn’t upload “big.mov” because the file is damaged.'],
    ['the file is damaged.', 'Nebula couldn’t upload “big.mov” because the file is damaged.'],
  ])('%s', (reason, line) => {
    expect(becauseLine({ heading: big, reason })).toBe(line);
  });

  it('the same rule where a named line’s rest becomes the clause', () => {
    expect(becauseLine({ heading: '', reason: 'Couldn’t download the result. File missing' }))
      .toBe('Nebula couldn’t download the result. File missing.');
    expect(becauseLine({ heading: '', reason: 'Couldn’t download the result. Its link may have expired.' }))
      .toBe('Nebula couldn’t download the result because its link may have expired.');
  });
});

describe('a reason that opens “Nebula couldn’t …” replaces the heading only for the same failure', () => {
  it('a different failure follows the heading’s action', () => {
    expect(becauseLine({ heading: 'Couldn’t delete “World”.', reason: "Nebula couldn't save its World Labs safeguards. Restart Nebula, then try again." }))
      .toBe('Nebula couldn’t delete “World”. Nebula couldn’t save its World Labs safeguards. Restart Nebula, then try again.');
    expect(becauseLine({ heading: 'Couldn’t run “Hero still”.',
      reason: 'Nebula couldn’t download the result from Replicate because its download link may have expired. Run the node again.' }))
      .toBe('Nebula couldn’t run “Hero still”. Nebula couldn’t download the result from Replicate because its download link may have expired. Run the node again.');
  });

  it('the same failure is one sentence, not the heading twice', () => {
    expect(becauseLine({ heading: 'Couldn’t stop the reply.', reason: 'Nebula couldn’t stop the reply. The agent isn’t answering.' }))
      .toBe('Nebula couldn’t stop the reply because the agent isn’t answering.');
    expect(becauseLine({ heading: 'Couldn’t save the project.', reason: 'Nebula couldn’t save the project because the disk is full.' }))
      .toBe('Nebula couldn’t save the project because the disk is full.');
    // A generic heading is replaced by the specific line.
    expect(becauseLine({ heading: 'Couldn’t delete the node.', reason: 'Nebula couldn’t delete “Agent scene” because “Shot 2” is still running. Stop the run first.' }))
      .toBe('Nebula couldn’t delete “Agent scene” because “Shot 2” is still running. Stop the run first.');
  });
});

describe('the caller hands over the action or the clause', () => {
  it('`what` and `clause` go in as written', () => {
    expect(becauseLine({ heading: '', reason: '', what: 'save “a” when Dr. Bot switched', clause: 'The Archivist is opening “Proj”.' }))
      .toBe('Nebula couldn’t save “a” when Dr. Bot switched because The Archivist is opening “Proj”.');
    expect(becauseLine({ heading: '', reason: '', what: "open Bob's thing" })).toBe("Nebula couldn’t open Bob's thing.");
    expect(becauseLine({ heading: '', reason: 'The server is busy.', what: 'run “Dr. Who”' }))
      .toBe('Nebula couldn’t run “Dr. Who” because the server is busy.');
  });

  it.each([
    ['The Archivist', 'Nebula couldn’t run “Hero” because The Archivist is opening “Proj”.'],
    ['Stop Motion Bot', 'Nebula couldn’t run “Hero” because Stop Motion Bot is opening “Proj”.'],
    ['Dr. Bot', 'Nebula couldn’t run “Hero” because Dr. Bot is opening “Proj”.'],
    ['Your Helper', 'Nebula couldn’t run “Hero” because your Helper is opening “Proj”.'],
    ['Codex', 'Nebula couldn’t run “Hero” because Codex is opening “Proj”.'],
  ])('an agent called %s keeps its name and the because (run)', (agent, line) => {
    expect(runWhileFollowingLine('Hero', agent, 'Proj')).toBe(line);
    expect(createWhileFollowingLine({ agent, projectName: 'Proj' }))
      .toBe(line.replace('run “Hero”', 'start the generation'));
  });

  it('with no agent name the reason keeps its own words', () => {
    expect(runWhileFollowingLine(null, null, 'Proj')).toBe('Nebula couldn’t run the canvas because an agent is opening “Proj”.');
    expect(createWhileFollowingLine(null)).toBe('Nebula couldn’t start the generation because another project is opening.');
  });

  it('the hand-off line starts “Nebula couldn’t” for a name with “. ” in it', () => {
    const copy = 'Recovered';
    for (const agent of ['Dr. Bot', 'Stop Motion Bot', 'Claude Code']) {
      expect(handoffFailedLine([{ node: 'Text', setting: 'prompt' }], 'Proj', agent, copy))
        .toBe(`Nebula couldn’t save “prompt” for “Text” in “Proj” when ${agent} switched projects. Your edits were saved as a copy, “${copy}”.`);
    }
  });
});

describe('curlApostrophes leaves a typed name alone', () => {
  it('a word with an underscore or a long extension keeps its apostrophe; a possessive still curls', () => {
    expect(curlApostrophes("Bob's_file")).toBe("Bob's_file");
    expect(curlApostrophes("Bob's.sketch")).toBe("Bob's.sketch");
    expect(curlApostrophes("Bob's.photoshop")).toBe("Bob's.photoshop");
    expect(curlApostrophes("Krea's limit")).toBe('Krea’s limit');
    expect(curlApostrophes("Krea's. Next")).toBe('Krea’s. Next');
  });
});

describe('one apostrophe rule for “Nebula couldn’t”', () => {
  const lines = [
    "Nebula couldn't save the project because x.", 'Nebula couldn’t save the project because x.',
    "Saved. Nebula couldn't load the settings back because x. Reload to see them.",
  ];
  it.each(lines)('%s', (line) => {
    expect(isBecauseFailure(line)).toBe(true);
    expect(new FailureNotice('', line).standalone).toBe(true);
  });

  it('a load line is a load line with either apostrophe', () => {
    expect(isLoadLine("Nebula couldn't load the models because x.")).toBe(true);
    expect(isLoadLine('Nebula couldn’t check the key because x.')).toBe(true);
    expect(isLoadLine("Nebula couldn't save the models because x.")).toBe(false);
  });

  it('a whole because line through becauseLine comes out curly outside quoted names', () => {
    expect(becauseLine({ heading: 'Couldn’t save the project.', reason: "Nebula couldn't save the project because x." }))
      .toBe('Nebula couldn’t save the project because x.');
    expect(becauseLine({ heading: '', reason: "Nebula couldn't open “Bob's.png” because it isn't there." }))
      .toBe("Nebula couldn’t open “Bob's.png” because it isn’t there.");
  });
});

describe('a failureCopy goes through oneLine and FailureLines whole', () => {
  it('a written line with no heading has an empty `what` that is not read as an action', () => {
    const line = 'Nebula couldn’t send the message because this tab isn’t connected as you. Open the link Nebula printed when it started.';
    const copy = failureCopy(new FailureNotice('', line));
    expect(copy.what).toBe('');
    expect(oneLine(copy)).toBe(line);
  });
});

describe('becauseLine: a dot is a sentence end only before whitespace or the end, never inside a code span or a quote', () => {
  it('keeps a dotted path in a code span whole, with no closing full stop, reading as it does with one', () => {
    expect(becauseLine({ heading: '', reason: "Couldn't read `~/it's/file.png` because it isn't there" }))
      .toBe("Nebula couldn’t read `~/it's/file.png` because it isn’t there.");
  });

  it('keeps it whole with a closing full stop, and names the action', () => {
    expect(becauseLine({ heading: '', reason: "Couldn't read `~/it's/file.png` because it isn't there." }))
      .toBe("Nebula couldn’t read `~/it's/file.png` because it isn’t there.");
    expect(becauseLine({ heading: '', reason: "Couldn't read `~/it's/file.png`. It isn't there." }))
      .toBe("Nebula couldn’t read `~/it's/file.png` because it isn’t there.");
  });

  it('keeps a bare dotted file name, a provider domain and a version inside the sentence', () => {
    expect(becauseLine({ heading: '', reason: "Couldn't read photo.png. The file moved." }))
      .toBe('Nebula couldn’t read photo.png because the file moved.');
    expect(becauseLine({ heading: '', reason: "Couldn't reach fal.ai. The server didn't answer." }))
      .toBe('Nebula couldn’t reach fal.ai because the server didn’t answer.');
    expect(becauseLine({ heading: '', reason: "Couldn't run Flux 1.1. The key was refused." }))
      .toBe('Nebula couldn’t run Flux 1.1 because the key was refused.');
    expect(failedWhat("Couldn't read photo.png.")).toBe('read photo.png');
    expect(failedWhat("Couldn't reach fal.ai.")).toBe('reach fal.ai');
    expect(failedWhat("Couldn't run Flux 1.1.")).toBe('run Flux 1.1');
  });

  it('still splits a two-sentence reason at the real sentence end', () => {
    expect(becauseLine({ heading: '', reason: "Couldn't read the file. It may have moved." }))
      .toBe('Nebula couldn’t read the file because it may have moved.');
  });

  it('keeps a quoted name with a dot whole', () => {
    expect(becauseLine({ heading: '', reason: "Couldn't open “a.b”. It may have moved." }))
      .toBe('Nebula couldn’t open “a.b” because it may have moved.');
    expect(failedWhat("Couldn't open “a. b”.")).toBe('open “a. b”');
  });

  it('does not end a sentence inside a code span that holds a dot and a space', () => {
    expect(failedWhat("Couldn't read `a. b`.")).toBe('read `a. b`');
  });

  it('adds one full stop after a reason that ends in a code span, and none when it already ends a sentence', () => {
    expect(becauseLine({ heading: "Couldn't read the file.", reason: 'The path is `~/a.png`' }))
      .toBe('Nebula couldn’t read the file because the path is `~/a.png`.');
    expect(becauseLine({ heading: "Couldn't read the file.", reason: 'The path is `~/a.png`.' }))
      .toBe('Nebula couldn’t read the file because the path is `~/a.png`.');
  });
});

/** Design: a reason's last full stop does not change what the line says. Backend reasons arrive both ways. */
const withStop = (text: string) => (/\.$/.test(text) ? text : `${text}.`);
const withoutStop = (text: string) => text.replace(/\.$/, '');
const sameLine = (heading: string, reason: string) => {
  const a = becauseLine({ heading, reason: withoutStop(reason) });
  const b = becauseLine({ heading, reason: withStop(reason) });
  expect(withStop(a)).toBe(withStop(b));
  return [a, b];
};

describe('a closing full stop does not change the line', () => {
  const REASONS = [
    "Couldn't read `~/it's/file.png` because it isn't there",
    "Couldn't download the result. Its link may have expired",
    'File exceeds 500 MB limit',
    "Nebula couldn't save the project because the disk is full",
    "Krea's key doesn't work",
  ];
  it.each(REASONS)('alone: %s', (reason) => {
    const [a, b] = sameLine('', reason);
    expect(a).toBe(b);
  });
  it.each(REASONS)('with a heading: %s', (reason) => {
    const [a, b] = sameLine("Couldn't save the project.", reason);
    expect(a).toBe(b);
  });

  it('gives the same exact words for the named cases', () => {
    expect(becauseLine({ heading: '', reason: "Couldn't download the result. Its link may have expired" }))
      .toBe('Nebula couldn’t download the result because its link may have expired.');
    expect(becauseLine({ heading: '', reason: "Nebula couldn't save the project because the disk is full" }))
      .toBe('Nebula couldn’t save the project because the disk is full.');
    expect(becauseLine({ heading: '', reason: "Krea's key doesn't work" })).toBe('Krea’s key doesn’t work.');
  });

  const FIXTURES: [string, string][] = [
    ...TABLE_ROWS.map((row) => [row.heading, row.reason] as [string, string]),
    ...PATTERN_LINES.map(([heading, reason]) => [heading, reason] as [string, string]),
  ];
  it.each(FIXTURES)('%s %s', (heading, reason) => {
    sameLine(heading, reason);
    sameLine('', reason);
  });
});

describe('becauseLine: ellipses, abbreviations, trailing links and colons', () => {
  const line = (reason: string, heading = '') => becauseLine({ heading, reason });
  const both = (reason: string, expected: string, heading = '') => {
    expect(line(reason, heading)).toBe(expected);
    expect(line(`${reason}.`, heading)).toBe(expected);
  };

  it('an ellipsis before a capital ends the sentence and its dots stay out of the action', () => {
    expect(line("Couldn't read the file... It is gone.")).toBe('Nebula couldn’t read the file because it is gone.');
    expect(line("Couldn't read the file... it is gone")).toBe('Nebula couldn’t read the file... it is gone.');
    expect(line("Couldn't read the file… It is gone")).toBe('Nebula couldn’t read the file because it is gone.');
    expect(line("Couldn't read the file.... It is gone.")).toBe('Nebula couldn’t read the file because it is gone.');
    expect(line('It is gone... Try again.', "Couldn't read the file.")).toBe('Nebula couldn’t read the file because it is gone... Try again.');
  });
  it('an ellipsis in the middle of a sentence does not end it', () => {
    const text = line("Couldn't read... the file. It is gone");
    expect(text).toBe('Nebula couldn’t read... the file because it is gone.');
    expect(line("Couldn't read the file… and the rest. It is gone")).toBe('Nebula couldn’t read the file… and the rest because it is gone.');
  });
  it('a trailing ellipsis stays, with no full stop after it', () => {
    expect(line("Couldn't read the file...")).toBe('Nebula couldn’t read the file...');
    expect(line("Couldn't read the file…")).toBe('Nebula couldn’t read the file…');
    expect(line("Couldn't read the file . . .")).toBe('Nebula couldn’t read the file…');
  });
  it('spaced dots read as an ellipsis', () => {
    expect(line("Couldn't read the file . . . It is gone.")).toBe('Nebula couldn’t read the file because it is gone.');
    expect(line("Couldn't read the file . . . it is gone")).toBe('Nebula couldn’t read the file . . . it is gone.');
  });
  it('a.m., p.m. and etc. before a capital end the sentence and keep their own dot', () => {
    expect(line("Couldn't connect at 3 p.m. It is down.")).toBe('Nebula couldn’t connect at 3 p.m. because it is down.');
    expect(line("Couldn't connect at 3 P.M. It is down.")).toBe('Nebula couldn’t connect at 3 P.M. because it is down.');
    expect(line("Couldn't connect at 9 a.m. It is down.")).toBe('Nebula couldn’t connect at 9 a.m. because it is down.');
    expect(line("Couldn't read the files, fonts, etc. It is gone.")).toBe('Nebula couldn’t read the files, fonts, etc. because it is gone.');
    expect(line("Couldn't connect at 3 p.m.")).toBe('Nebula couldn’t connect at 3 p.m.');
  });
  it('a kept abbreviation dot or an ellipsis is the full stop: no second one goes after it', () => {
    // The heading-only path (no reason), and a reason that follows the action as its own sentence.
    expect(becauseLine({ heading: "Couldn't connect at 3 p.m.", reason: '' })).toBe('Nebula couldn’t connect at 3 p.m.');
    expect(becauseLine({ heading: "Couldn't read the files, fonts, etc.", reason: '' })).toBe('Nebula couldn’t read the files, fonts, etc.');
    expect(becauseLine({ heading: "Couldn't connect at 3 p.m.", reason: 'Wait a moment' })).toBe('Nebula couldn’t connect at 3 p.m. Wait a moment.');
    expect(becauseLine({ heading: "Couldn't connect at 3 p.m.", reason: '', what: 'connect…' })).toBe('Nebula couldn’t connect…');
    expect(becauseLine({ heading: "Couldn't load the file.", reason: '' })).toBe('Nebula couldn’t load the file.');
    // A node card's text that is not a clause follows the action as its own sentence.
    expect(couldntLine('connect at 3 p.m.')).toBe('Nebula couldn’t connect at 3 p.m.');
    expect(couldntLine('connect…')).toBe('Nebula couldn’t connect…');
    expect(couldntLine('load the file')).toBe('Nebula couldn’t load the file.');
  });
  it('e.g., i.e., vs. and U.S. before a capital stay one sentence, as before', () => {
    expect(line("Couldn't reach the U.S. It is down.")).toBe('Nebula couldn’t reach the U.S. It is down.');
    expect(line("Couldn't read the file, e.g. It is gone.")).toBe('Nebula couldn’t read the file, e.g. It is gone.');
  });
  it('endedSentence trims trailing whitespace first', () => {
    expect(endedSentence('x. ')).toBe('x.');
    expect(endedSentence('x  ')).toBe('x.');
    expect(endedSentence('x. . . ')).toBe('x. . .');
  });

  it('abbreviations do not end a sentence', () => {
    both("Couldn't reach the U.S. region because it is down", 'Nebula couldn’t reach the U.S. region because it is down.');
    both("Couldn't read the file, i.e. the image, because it is gone", 'Nebula couldn’t read the file, i.e. the image, because it is gone.');
    both("Couldn't read the file, e.g. the photo. It is gone", 'Nebula couldn’t read the file, e.g. the photo because it is gone.');
    both("Couldn't send before 9 a.m. Try again", 'Nebula couldn’t send before 9 a.m. Try again.');
    both("Couldn't read the files vs. the folder. It is gone", 'Nebula couldn’t read the files vs. the folder because it is gone.');
    both("Couldn't read the images, etc. and the audio. It is gone", 'Nebula couldn’t read the images, etc. and the audio because it is gone.');
  });
  it('a sentence that ends in an abbreviation still ends', () => {
    expect(line("Couldn't reach the U.S. Try again.")).toBe('Nebula couldn’t reach the U.S. Try again.');
    expect(line("Couldn't reach the server in the U.S.")).toBe('Nebula couldn’t reach the server in the U.S.');
  });

  it('a trailing link or colon gets no full stop', () => {
    expect(endedSentence('See https://fal.ai/docs')).toBe('See https://fal.ai/docs');
    expect(endedSentence('Error:')).toBe('Error:');
    expect(endedSentence('Reason follows:')).toBe('Reason follows:');
    expect(line('Error:')).toBe('Error:');
    expect(line('See https://fal.ai/docs')).toBe('See https://fal.ai/docs');
  });
  it('a reason that ends in a code span gets one full stop', () => {
    expect(endedSentence('`~/a.png`')).toBe('`~/a.png`.');
    expect(line('`~/a.png`')).toBe('`~/a.png`.');
    expect(line('See `https://fal.ai/x`')).toBe('See `https://fal.ai/x`.');
  });

  it('decimals, links, Windows paths, an unclosed backtick, ? and !, trailing space and empty reasons stay whole', () => {
    both("Couldn't upload 1.5 MB. It is too large", 'Nebula couldn’t upload 1.5 MB because it is too large.');
    expect(line("Couldn't read https://fal.ai/x.png. It is gone")).toBe('Nebula couldn’t read https://fal.ai/x.png because it is gone.');
    expect(line("Couldn't read https://fal.ai/x.png")).toBe('Nebula couldn’t read https://fal.ai/x.png.');
    expect(line("Couldn't read C:\\a.b\\c. It is gone")).toBe('Nebula couldn’t read C:\\a.b\\c because it is gone.');
    expect(line("Couldn't read `a. It is gone")).toBe('Nebula couldn’t read `a because it is gone.');
    expect(line('Is it there?', "Couldn't read the file.")).toBe('Nebula couldn’t read the file. Is it there?');
    expect(line('It is gone!', "Couldn't read the file.")).toBe('Nebula couldn’t read the file because it is gone!');
    expect(line("Couldn't read the file because it is gone   ")).toBe('Nebula couldn’t read the file because it is gone.');
    expect(line('', "Couldn't read the file.")).toBe('Nebula couldn’t read the file.');
    expect(line('`a.b`', "Couldn't read the file.")).toBe('Nebula couldn’t read the file because `a.b`.');
  });
});
