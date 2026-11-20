import { describe, expect, it } from 'vitest';
import { headedLine, isGenericHeading, isNamedLine } from '../src/lib/errorCopy';

/**
 * PR #198, design's ruling ("A specific line replaces the generic one, never both").
 *
 * headedLine decides "generic or specific" by the heading's role, not by
 * curly quotes: a generic heading names nothing the reason could add to
 * (isGenericHeading); a heading that names a thing keeps its place over a
 * reason that names another.
 */

const SHOT_RUNNING = "Couldn’t remove “Shot 2”. It’s still running. Stop the run first.";
const AGENT_SCENE = "Couldn't delete “Agent scene”. “Shot 2” is still running. Stop the run first.";

/** Every pair tried against headedLine, then the
 * call sites' own headings over the backend's named lines. `alone` means the
 * reason shows by itself; `both` means "<heading> <reason>". */
const TABLE: [heading: string, reason: string, shown: 'alone' | 'both', why: string][] = [
  // The pairs first tried.
  ["Couldn't run the graph.", "Couldn't reach the provider. Check your connection and try again.", 'both',
    'the heading names the run; the reason is its cause'],
  ["Couldn't run the canvas.", "Couldn't reach TypeSafe. Check your connection and try again.", 'both',
    'the heading names the run; the reason is its cause'],
  ["Couldn't save the project.", "Couldn't upload hero.png.", 'both',
    'the heading names the project; the upload is a step of it'],
  ["Couldn't delete 3 nodes.", AGENT_SCENE, 'alone',
    'a generic delete heading; the reason is the same failure, named'],
  ["Couldn't delete “Brief”.", AGENT_SCENE, 'both',
    'same verb, another node: two failures, Brief kept'],
  ["Couldn't save “Scene” for “Opening”.", SHOT_RUNNING, 'alone',
    'the generic save line for a setting; the reason names the part it refused'],
  ["Couldn't run “Hero still”.", "Couldn’t download the result from Replicate. Its download link may have expired.", 'both',
    'the heading names the node; the reason is its cause'],
  ["Couldn't make that connection.", "Couldn't delete “Scene”. “Shot 2” is still running. Stop the run first.", 'both',
    'the heading names another action (a connection) the reason does not cover'],
  ["Couldn't import the graph.", "Can't open that file. It isn't a Nebula graph.", 'both',
    'the heading names the import; the reason is its cause'],
  ["Couldn't stop the reply.", "Couldn't stop the reply. The agent isn't answering.", 'alone',
    'the reason repeats the heading'],
  // The call sites' generic headings.
  ["Couldn't delete the node.", AGENT_SCENE, 'alone', 'deletionHeading(1), same verb'],
  ["Couldn't delete 2 nodes.", AGENT_SCENE, 'alone', 'deletionHeading(2), same verb'],
  ["Couldn't delete “Agent scene”.", AGENT_SCENE, 'alone', 'the reason repeats the heading'],
  ["Couldn't undo.", "Nebula couldn’t undo because it would remove “Shot 2”, which is still running. Stop the run first.", 'alone',
    'runLockedLine("undo"): the reason repeats the heading'],
  ["Couldn't save the scene.", SHOT_RUNNING, 'alone', 'a generic save; the reason names the part it refused'],
  ["Couldn't save a setting on “Opening”.", SHOT_RUNNING, 'alone', 'paramSaveFailedLine with no label'],
  ["Couldn't save 3 settings for “Opening”.", SHOT_RUNNING, 'alone', 'paramSaveFailedLine, several'],
  ["Couldn't save the scene.", "Couldn't reach the provider. Check your connection and try again.", 'both',
    'a generic save, but the reason names no part of it'],
  ["Couldn't delete the node.", "Couldn't reach the provider. Check your connection and try again.", 'both',
    'a generic delete, but the reason is another failure'],
  ["Couldn't run the node.", "Couldn't run “Hero”. Its key is missing.", 'alone', 'generic, same verb'],
  ["Couldn't clear the canvas.", 'Cannot clear the canvas while a run is active. Wait for the run to finish or stop it first.', 'alone',
    'the backend line repeats the heading in another form'],
  ["Couldn't refresh the source.", "Paper can’t find the object. Link it again.", 'both',
    'the heading names the refresh; the reason is its cause'],
  ["Couldn't run “Hero still”.", "Couldn't reach Krea.", 'both', 'a heading that names a thing keeps its place over a reason that names another'],
  ["Couldn't delete the node.", 'It is locked.', 'both', 'not a line of its own'],
];

describe('headedLine decides by the heading\'s role', () => {
  it.each(TABLE)('%s + %s → %s (%s)', (heading, reason, shown) => {
    expect(headedLine(heading, reason)).toBe(shown === 'alone' ? reason : `${heading} ${reason}`);
  });

  it('the generic headings are the ones that name nothing', () => {
    for (const heading of ["Couldn't delete the node.", "Couldn't delete 4 nodes.", "Couldn't save the scene.",
      "Couldn't undo.", "Couldn't redo.", "Couldn't save “Scene” for “Opening”.", "Couldn't save “A” and “B” for “N”.",
      "Couldn't save a setting on “N”.", "Couldn’t save your edits.", "Couldn't undo the change."]) {
      expect(isGenericHeading(heading), heading).toBe(true);
    }
    for (const heading of ["Couldn't run the graph.", "Couldn't save the project.", "Couldn't delete “Brief”.",
      "Couldn't make that connection.", "Couldn't import the graph.", "Couldn't change the model for “N”.",
      "Couldn't run “Hero still”.", "Couldn't upload hero.png."]) {
      expect(isGenericHeading(heading), heading).toBe(false);
    }
  });

  it('either side empty', () => {
    expect(headedLine('', AGENT_SCENE)).toBe(AGENT_SCENE);
    expect(headedLine("Couldn't delete the node.", '')).toBe("Couldn't delete the node.");
  });
});

describe('isNamedLine knows every form a backend person line takes', () => {
  // Real backend person lines (backend/, 2026-10-27).
  it.each([
    "Couldn't delete “Agent scene”. “Shot 2” is still running. Stop the run first.",
    "Nebula couldn’t undo because it would remove “Shot 2”, which is still running. Stop the run first.",
    "Couldn’t download the result from Replicate. Its download link may have expired. Run the node again.",
    "Nebula couldn’t get the image because that address isn’t public. Use a public image URL.",
    "Nebula can’t read that file type. Use JPG, PNG, WebP, GIF, HEIC, MP4 or MOV.",
    "Nebula couldn’t confirm the object in Paper. Refresh the source again.",
    "Nebula couldn’t get the image at that URL. Check the address, or save the image and upload it.",
    'Cannot clear the canvas while a run is active. Wait for the run to finish or stop it first.',
    'Cannot switch projects while a run is active. Wait for the run to finish or stop it first.',
    "Can't open that file. It isn't a Nebula graph.",
    'Couldn’t copy. Select the text and copy it yourself.',
  ])('a line of its own: %s', (line) => {
    expect(isNamedLine(line)).toBe(true);
  });

  it.each([
    'Stop the run first.',
    'Wait for it to finish.',
    'Wait for the active run to finish.',
    "Nebula's server isn't answering. Make sure it's running, then try again.",
    "Nebula didn't respond. Try again.",
    'Try again, or reload if it keeps happening.',
    "It's still running.",
  ])('a reason, not a line of its own: %s', (line) => {
    expect(isNamedLine(line)).toBe(false);
  });
});
