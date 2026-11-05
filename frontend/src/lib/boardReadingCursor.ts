/**
 * The agent cursor's look sweep over the board while an agent's read runs
 * (GM's board reading design section 2: "its cursor does the look sweep over
 * the board with the say line “Reading the board”"). The sweep itself comes
 * with the agent cursor's board work (PR #211, not merged when Read the board
 * was built): until then the say line goes to the Agent log
 * (backend main._say_agent_action) and this hook has no taker.
 *
 * Follow-up when #211 lands: its cursor layer calls `onBoardReadingSweep`
 * and sweeps `imageIds` on `boardId` until a sweep with `running: false`.
 */

export interface BoardReadingSweep {
  boardId: string;
  /** The agent's id (its cursor), from the run's `by`. */
  agentId: string;
  agentName: string;
  /** The board's images in board order, for the sweep's path. */
  imageIds: string[];
  /** False when the read ended (done, failed or stopped): the sweep stops. */
  running: boolean;
}

export type BoardReadingSweepHandler = (sweep: BoardReadingSweep) => void;

let taker: BoardReadingSweepHandler | null = null;

/** The cursor layer takes the sweeps; returns how to let go. */
export function onBoardReadingSweep(handler: BoardReadingSweepHandler): () => void {
  taker = handler;
  return () => { if (taker === handler) taker = null; };
}

/** Say a sweep starts or stops (no-op until a cursor layer takes them). */
export function boardReadingSweep(sweep: BoardReadingSweep): void {
  taker?.(sweep);
}
