import { nodeNameList, quotedNames } from './errorCopy';

/**
 * What a Cinema scene says when the backend doesn't take its save (GM -
 * Design, PR #198 r6 item 1 and r7 item 1). Each refusal gets the line for
 * what clears it, never one shared suffix, and a specific line replaces the
 * generic one, never both.
 */

/** "Couldn’t save your changes to “Opening”." The heading of the lines
 * below that keep their edits for a retry (not the 400 and 413 lines, which
 * are GM's own). */
export function sceneSaveHeading(scene: string): string {
  return `Couldn’t save your changes to “${scene}”.`;
}

/** GM (2026-10-28, #198 r12 answer 1; r22 Q3: one line per status
 * everywhere, a save that wasn't stopped too): a save refused 400 or 413 can
 * never succeed as it is: said once, nothing retries by itself, and no line
 * promises a retry. [Try again] goes with it, on the toast and in the
 * "Unsaved" mark's popover. The status and code go to the Agent log only.
 * 400, verbatim: */
export function sceneCantSaveLine(scene: string): string {
  return `Nebula can’t save your changes to “${scene}”.`;
}
/** 413, verbatim: */
export function sceneTooBigToSaveLine(scene: string): string {
  return `“${scene}” is too big to save. Remove something from it, then try again.`;
}

/** Clears by itself (a paid start, an approved run's inputs, any run lock;
 * GM r7, reworded r9): "…They're kept and will save when the run finishes." */
export const KEPT_UNTIL_RUN_ENDS = "They’re kept and will save when the run finishes.";

/** A server error, with the automatic retry the canvas makes (GM r9; GM r29
 * Q1: the subject and the comma, and the present tense, since Nebula is
 * doing it now): "Nebula couldn’t save your changes to “Opening”. They’re
 * kept, and Nebula is trying again." Several scenes take the shared name
 * list (up to 3 by name, from 4 a count).
 * After SCENE_SERVER_RETRIES timed tries the timer stops: KEPT_UNTIL_NEXT_CHANGE. */
export const KEPT_AND_TRYING = 'They’re kept, and Nebula is trying again.';
export function sceneRetryingLine(scenes: readonly string[]): string {
  const names = quotedNames(scenes, 'scenes');
  return `Nebula couldn’t save your changes to ${names}. ${KEPT_AND_TRYING}`;
}

/** The timed retries stopped (GM r11 answer 3; r28: the subject and the
 * comma): "Nebula couldn’t save your changes to “Opening”. They’re kept, and
 * Nebula will try again with your next change.", with [Try again]. A
 * reconnect still sends them by itself. */
export const KEPT_UNTIL_NEXT_CHANGE = 'They’re kept, and Nebula will try again with your next change.';
/** GM r11 answer 3, r28: the line once the timed retries stopped. */
export function sceneStoppedLine(scene: string): string {
  return sceneStopStateLine('server', [scene]);
}

/** Why a scene's save stopped, for its stop line (GM r28): 400 (can't
 * save), 413 (too big), a server error that went on (still failing). A save
 * another writer kept refusing says its own line, scene by scene. */
export type SceneStopCause = 'bad-save' | 'too-big' | 'server';

/** GM r28, verbatim: a stop line is a state, one line per cause, naming its
 * scenes with the shared rule (up to 3 by name, from 4 a count). One scene
 * keeps its singular line.
 * - 400: "Nebula can’t save your changes to “Opening” and “Ref scene”."
 * - Still failing: "Nebula couldn’t save your changes to “Opening” and “Ref
 *   scene”. They’re kept, and Nebula will try again with your next change."
 * - 413: "“Opening” and “Ref scene” are too big to save. Remove something
 *   from them, then try again."; from 4, "4 scenes are too big to save. …" */
export function sceneStopStateLine(cause: SceneStopCause, scenes: readonly string[]): string {
  const names = quotedNames(scenes, 'scenes');
  if (cause === 'bad-save') return `Nebula can’t save your changes to ${names}.`;
  if (cause === 'server') return `Nebula couldn’t save your changes to ${names}. ${KEPT_UNTIL_NEXT_CHANGE}`;
  if (scenes.length === 1) return sceneTooBigToSaveLine(scenes[0]);
  return `${names} are too big to save. Remove something from them, then try again.`;
}

/** Who changed a scene the person was editing (review 11, L-1; GM r19 answer
 * 3): an agent by name or with none; another window, only when Nebula knows
 * the writer was one of the person's own tabs (this launch's person token);
 * else unknown (a script with no marker, Nebula itself, no writer recorded),
 * and the line says nothing about who. */
export type SceneWriter = { kind: 'agent'; name: string | null } | { kind: 'window' } | { kind: 'unknown' };
/** The same, for the stop line (GM r18 answer 2). */
export type SceneOutpacedBy = SceneWriter;
export const UNKNOWN_WRITER: SceneWriter = { kind: 'unknown' };

/** The writer a backend `changedBy` (or `deletedBy`) names: "person" is the
 * person's own tab (another window), an agent by its name; anything else,
 * or none, is unknown (GM r19 answer 3). */
export function sceneWriterOf(by: { kind?: unknown; name?: unknown } | null | undefined): SceneWriter {
  if (by?.kind === 'agent') return { kind: 'agent', name: typeof by.name === 'string' && by.name.trim() ? by.name : null };
  if (by?.kind === 'person') return { kind: 'window' };
  return UNKNOWN_WRITER;
}
/** Whether two changes have the same writer (a clash keeps one author). */
export function sameSceneWriter(a: SceneWriter, b: SceneWriter): boolean {
  return a.kind === b.kind && (a.kind !== 'agent' || a.name === (b as { name: string | null }).name);
}

/** GM r18 answer 2: the save stopped because another writer kept changing
 * the scene, not because saving failed. The line names the writer and says
 * when Nebula tries again (verbatim, ’ per the sweep): "Codex kept changing
 * “Opening”, so your changes aren’t saved yet. Nebula will try again when
 * Codex stops." A real server failure keeps sceneStoppedLine. */
export function sceneOutpacedLine(scene: string, by: SceneOutpacedBy): string {
  const notYet = 'so your changes aren’t saved yet.';
  if (by.kind === 'window') return `“${scene}” kept changing in another window, ${notYet} Nebula will try again when it stops.`;
  // GM r19 answer 3: an unknown writer, and nothing said about who.
  if (by.kind === 'unknown') return `“${scene}” kept changing, ${notYet} Nebula will try again when it stops.`;
  if (by.name) return `${by.name} kept changing “${scene}”, ${notYet} Nebula will try again when ${by.name} stops.`;
  return `An agent kept changing “${scene}”, ${notYet} Nebula will try again when it stops.`;
}
export const TRY_AGAIN = 'Try again';

/** GM r20 answer 3: the scene was deleted, so the save can never succeed:
 * said once, and nothing retries. The writer is named when known, "another
 * window" only for the person's own tab, else nothing about who: "“Opening”
 * was deleted, so your changes to it can’t be saved." If the delete is
 * undone (the Agent log), the line stays and the save picks back up. */
export function sceneDeletedLine(scene: string, by: SceneWriter): string {
  const tail = 'so your changes to it can’t be saved.';
  if (by.kind === 'agent') return `${by.name ?? 'An agent'} deleted “${scene}”, ${tail}`;
  if (by.kind === 'window') return `“${scene}” was deleted in another window, ${tail}`;
  return `“${scene}” was deleted, ${tail}`;
}

/** GM r22 note 3: an agent's write that deleted the scene and did more
 * besides is one toast, one sentence: "Codex changed the canvas and deleted
 * “Opening”, so your changes to it can’t be saved." (several scenes: “A”
 * and “B”, "to them"). */
export function sceneChangedAndDeletedLine(agent: string, scenes: readonly string[]): string {
  return agentDeletedLine(`${agent} changed the canvas`, scenes);
}

/** GM r24 answer 1: an agent's undo that deleted the scene is one sentence
 * too: "Codex undid its edit and deleted “Opening”, so your changes to it
 * can’t be saved." */
export function sceneUndidAndDeletedLine(agent: string, scenes: readonly string[]): string {
  return agentDeletedLine(`${agent} undid its edit`, scenes);
}

function agentDeletedLine(lead: string, scenes: readonly string[]): string {
  const them = scenes.length > 1 ? 'them' : 'it';
  return `${lead} and deleted ${quotedNames(scenes, 'scenes')}, so your changes to ${them} can’t be saved.`;
}

/** The workspace moved (GM r7): "Codex switched to “Y” first."; the person
 * in another window (GM r9 answer 4): "You switched to “Y” in another window
 * first."; nobody known: "Nebula switched to “Y” first." */
export function switchedFirst(project: string, agent: string | null, byPerson = false): string {
  if (!agent && byPerson) return `You switched to “${project}” in another window first.`;
  return `${agent ?? 'Nebula'} switched to “${project}” first.`;
}
/** The workspace moved and the backend named no project (an unfiled
 * canvas; GM r8, verbatim). */
export const SWITCHED_UNNAMED = 'The canvas switched to another project first.';

/** The scene card's mark while its edits aren't saved (GM r9: "Unsaved", to
 * match the bar's "Unsaved changes"): a small label under the card's header,
 * its tooltip the same sentence as its cause's toast. */
export const UNSAVED_MARK = 'Unsaved';

/** The scene changed somewhere else while the person had edits it hadn't
 * saved, and both changed the same thing (GM r9 decision 2; GM r12: one
 * sentence, "Choose which version to keep." dropped from the toast and the
 * tooltip alike). The person's edits stay on screen, marked "Unsaved", until
 * they choose. Edits that don't overlap are merged and saved without a line
 * (graphStore rebaseScene). `scene` is what changed: the scene, or (GM r13
 * answer 1) a shot the other side put back with other text, by its current
 * name ("Codex changed “Shot 2” while you were editing it."). */
export function sceneClashLine(scene: string, by: SceneWriter): string {
  if (by.kind === 'agent') return `${by.name ?? 'An agent'} changed “${scene}” while you were editing it.`;
  if (by.kind === 'window') return `“${scene}” was changed in another window while you were editing it.`;
  // GM r19 answer 3, r20 answer 2: an unknown writer, passive, no actor.
  return `“${scene}” changed while you were editing it.`;
}

/** GM r10 answer 3: each kind of clash its own line, verbatim. Both sides
 * reordered the shots: "Codex reordered the shots in “Opening” while you
 * were editing them." The other side removed a shot the person changed:
 * "Codex removed “Shot 2” while you were editing it."; several (GM r12 answer
 * 3, active voice, the shared name list): "Codex removed “Shot 2” and “Shot
 * 3” while you were editing them." The person's other window: "…in another
 * window…" in the same shapes. An unknown writer (GM r20 answer 2): passive,
 * no actor: "The shots in “Opening” were reordered while you were editing
 * them.", "“Shot 2” was removed while you were editing it." */
export function sceneReorderedLine(scene: string, by: SceneWriter): string {
  if (by.kind === 'agent') return `${by.name ?? 'An agent'} reordered the shots in “${scene}” while you were editing them.`;
  const where = by.kind === 'window' ? ' in another window' : '';
  return `The shots in “${scene}” were reordered${where} while you were editing them.`;
}
export function shotsRemovedLine(shots: readonly string[], by: SceneWriter): string {
  const names = quotedNames(shots, 'shots');
  const them = shots.length === 1 ? 'it' : 'them';
  if (by.kind === 'agent') return `${by.name ?? 'An agent'} removed ${names} while you were editing ${them}.`;
  const where = by.kind === 'window' ? ' in another window' : '';
  return `${names} ${shots.length === 1 ? 'was' : 'were'} removed${where} while you were editing ${them}.`;
}

/** GM r11 answer 4 and r12 answer 3: Keep mine brought removed shots back,
 * and connections of theirs can't come back (the other end is gone, or a
 * single-connection input now holds another connection, which is never
 * replaced). One line for all of them: "“Shot 2” is back without its
 * connection to “Edit A”.", "“Shot 2” is back without its connections to
 * “Edit A” and “Edit B”.", "“Shot 2” and “Shot 3” are back without their
 * connections to “Edit A”." The nodes go through the one node-name list
 * (errorCopy nodeNameList), the shots through the same rule. */
export function shotBackWithoutLine(shots: readonly string[], targets: readonly string[]): string {
  const several = shots.length > 1;
  const what = several || targets.length > 1 ? 'connections' : 'connection';
  return `${quotedNames(shots, 'shots')} ${several ? 'are' : 'is'} back without ${several ? 'their' : 'its'} ${what} to ${nodeNameList([...targets])}.`;
}
/** The clash's two buttons (GM r9). */
export const KEEP_MINE = 'Keep mine';
export function theirsLabel(agent: string | null): string {
  // GM r12 answer 2: the curly apostrophe, as #195's "Undid Codex’s edit".
  return agent ? `Use ${agent}’s` : 'Use theirs';
}
