import { backendWebSocketUrl, personTokenForSocket } from './backend';
import { TAB_ID, onTabIdRekeyed, tabIdConfirmed, tabIdReady, withTabClaim } from './tabId';
import { dropRefusedPersonToken, notePersonPromoted, onPersonConnected, reportPersonRequired } from './personSession';
import type { PortValue, VariantScope } from '../types';
import type { ExecutionStatusResult } from './api';
import type { AgentNotesEvent } from './agentNotes';
import type {
  ProviderRecoveryCheckpoint,
  ProviderStartAmbiguity,
  ProviderStartKind,
} from './runHistory';
import type { AssetProposalClosedEvent, AssetProposalOpenedEvent, AssetProposalSyncEvent } from './assetProposals';
import type { QuestionsClosedEvent, QuestionsOpenedEvent, QuestionsSyncEvent } from './agentQuestions';
import type { ChannelListenersEvent, PersonThreadEvent } from './personThread';

export type ErrorCategory =
  | 'blocked'
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'invalid_input'
  | 'unknown';

/** Where an agent cursor points: a node, one of its ports, a flow-space spot,
 * or an item on a surface beside the canvas (Phase 3, "Anywhere"): the
 * Moodboard panel and Studio, one surface. `itemId` is `<board>` or
 * `<board>/<image>` (ids only, whatever the agent called the item); `part`
 * is a control: name, direction, avoid, colors or colors-out (the keep-out
 * colors) on a board, note or weight
 * on an image. The DOM carries the same string as `data-agent-anchor`
 * (lib/agentAnchors.ts). */
export type AgentCursorAnchor =
  | { nodeId: string; handle?: string }
  | { x: number; y: number }
  | { surface: 'moodboard'; itemId: string; part?: string };

/** What a surface item is called, beside its anchor (never in it: tabs
 * compare anchors whole), so a line or a launcher park can name an item that
 * isn't on screen. `image` is the image's number on its board. */
export interface AgentAnchorNames {
  board: string;
  image?: number;
  part?: string;
}

/** graphSync.projectSwitch: who opened or made a project, and what was open
 * before (backend main.py _switch_notice). */
export interface ProjectSwitch {
  /** `tab`: the person's reopen in place, from that tab (its X-Nebula-Tab). */
  actor: { kind: 'agent' | 'anonymous' | 'system' | 'person' | string; name?: string; color?: string; tab?: string };
  projectId: string;
  projectName: string;
  previousProjectId: string | null;
  previousProjectName: string | null;
  /** The revision the canvas had before the switch. */
  previousRevision: string;
  created?: boolean;
}

export { AGENT_CURSOR_ACTIONS, type AgentCursorAction } from './agentPresenceActions';

/** Which session of its agent a cursor is: an opaque key the backend derives
 * (never the agent's own id) and its number, the lowest free among the
 * agent's live sessions, held until its cursor leaves. The backend is the one
 * place that numbers, so every tab agrees ("Claude · 2"). Display only. */
export interface AgentPresenceSession {
  key: string;
  ordinal: number;
}

export interface AgentPresenceEvent {
  type: 'agentPresence';
  agent: { id: string; name: string; color: string; verified: boolean };
  /** Absent for an action with no place on the canvas (a moodboard write):
   * the Agent log lists it (agentLogStore) and no cursor moves. */
  target?: AgentCursorAnchor;
  /** Present with a surface target (Phase 3). */
  anchorNames?: AgentAnchorNames;
  from?: AgentCursorAnchor;
  /** One of AGENT_CURSOR_ACTIONS; anything else is read as 'move' (forward compatible). */
  action: string;
  say: string;
  /** The Agent log's words when they differ from the bubble's (GM - Design,
   * round 16 of PR #195; PR #198 r1, GM item 7): a field the card shows no
   * label for, which the bubble leaves out, is named here by its key; an
   * action whose bubble says nothing (a universal node's setting with no
   * label) still has its line here. Absent: the log uses `say` (and a bare
   * cursor move has none). */
  log?: string;
  /** Backend wall-clock milliseconds. */
  at: number;
  /** The project open when it happened (the Agents panel lists it only there). */
  projectId?: string | null;
  /** On a `propose` cursor: the proposal it waits on (lib/agentCursorSettled). */
  proposalId?: string;
  /** What the action was, for the Agents panel (Q125 item 2): a past-tense
   * verb and the node it names, and how long ago it was (a click or a drag
   * keeps the agent's last action). Absent when the agent has none. */
  did?: { verb: string; nodeId: string | null; label: string | null; secondsAgo?: number };
  /** Person tabs only: which session of this agent and its number (display
   * only). Every cursor event a person tab gets carries it, the agent's plain
   * cursor's too; the agents' form never does. */
  session?: AgentPresenceSession;
  /** Person tabs only: backend wall-clock ms when this cursor came to where
   * it is (a move to the same node, or a nudge, keeps it). Columns stack by
   * it, so every tab, before and after a reload, draws the same cursors in
   * full (GM - Design, PR #211 r21). */
  since?: number;
  /** Person tabs only: this event's own id, so the Agent log lists an action
   *  once, a live event and its replay alike, and never drops a real repeat
   *  (#211 follow-up, LOW-5). */
  eventId?: string;
}

/** Person tabs only: a node move changed these session cursors' target
 *  chains (the other cursors linked to each through targets 16 canvas units
 *  apart), so they arrive now (backend agent_presence.carry_nodes, GM -
 *  Design #219 r24 Q2). Every tab, and a reload, stack them by these. */
export interface AgentPresenceArrivalEvent {
  type: 'agentPresenceArrival';
  cursors: { agentId: string; key: string; ordinal: number; since: number }[];
}

/** Person tabs only: the backend dropped these cursors (their board was
 *  deleted), so they leave here too, and their numbers are free. `key` is the
 *  session's key, null for an agent's plain cursor. */
export interface AgentPresenceLeaveEvent {
  type: 'agentPresenceLeave';
  cursors: { agentId: string; key: string | null }[];
}

/** Person tabs only: the backend moved these cursors to a board (the image
 *  they were on was removed elsewhere), so they go there here too. */
export interface AgentPresenceRetargetEvent {
  type: 'agentPresenceRetarget';
  cursors: { agentId: string; key: string | null; target: AgentCursorAnchor; anchorNames?: AgentAnchorNames }[];
}

/** Person tabs only, right after a verified hello: every live cursor, so a
 * tab that connects mid-session shows the same cursors and numbers as the
 * others (GM - Design, PR #211 r3). Each is drawn where it is, no flight. */
export interface AgentPresenceReplayEvent {
  type: 'agentPresenceReplay';
  cursors: (AgentPresenceEvent & { replay?: boolean; secondsAgo?: number })[];
}

/** An agent's status line changed (backend services/agent_status.py, Q125 item 2). */
export interface AgentStatusEvent {
  type: 'agentStatus';
  agent: { id: string; name: string; color: string; verified: boolean };
  /** Null once cleared or expired. */
  status: { text: string; nodeId: string | null; projectId: string | null; at: number; secondsAgo: number } | null;
  change: 'set' | 'cleared' | 'expired' | 'unanchored';
  /** Rises with every change; a roster read says the one it saw. */
  rev: number;
}

/**
 * A node of a run an agent started began or stopped running (Q125 item 3;
 * backend services/run_done_cards.py AgentRunBook): the agent's mark on it.
 */
export interface AgentRunEvent {
  type: 'agentRun';
  agent: { id: string; name: string; color: string; verified: boolean };
  runId: string;
  nodeId: string;
  /** The model as its provider spells it ("FLUX.2 [pro]"), or the node's name. */
  model: string | null;
  projectId: string | null;
  change: 'started' | 'ended';
  /** How long the node has run (when it started, for `started`: about 0). */
  secondsAgo: number;
}

/** A short note the person pinned for agents (backend services/canvas_pins.py). */
export interface Pin {
  id: string;
  text: string;
  anchor: { nodeId: string } | { x: number; y: number };
  /** Last known flow position (the node's, or the spot). */
  position: { x: number; y: number } | null;
  status: 'open' | 'resolved';
  /** ISO timestamp. */
  createdAt: string;
  /** True once the node it was pinned to was removed; it stays where the node was. */
  detached: boolean;
  detachedFrom?: string;
  reply: {
    agent: { id: string; name: string; color: string; verified: boolean };
    text: string;
    at: string;
  } | null;
}

/** Said by this client, never the backend: a socket opened after an earlier
 *  one closed. The backend doesn't replay what it sent while no socket was
 *  open (main.py /ws; only the graph comes again, as graphSync), so whatever
 *  shows a saved board or Character reads it again (storedAssetsStore, the
 *  Moodboard Studio, the Assets panel). */
export interface SocketReconnectedEvent {
  type: 'socketReconnected';
}

/** Said by this client, never the backend: the server refused this socket's
 *  hello (its `personRequired` frame), so it gets the agents' form from now
 *  on. Person-only state the tab drew (numbered cursors) goes. */
export interface SocketDemotedEvent {
  type: 'socketDemoted';
}

/** A saved moodboard, character or Style changed (backend main.py
 *  _broadcast_stored_asset), so a card or list that shows it fetches it again. */
export interface StoredAssetChangedEvent {
  type: 'storedAssetChanged';
  kind: 'moodboard' | 'character' | 'style';
  id: string;
  deleted: boolean;
  /** Only after a move (POST .../move): where it lives now, null for Global. */
  projectId?: string | null;
  /** The board's version after the write (moodboards; contract 07 section 1.12). */
  version?: number;
  /** Who wrote it (`tab` only for the person's own tab: the Studio skips its
   *  own echo), what it touched, and its undo (null over 200 ops, or a PUT). */
  edit?: { actor?: { kind?: string; id?: string; name?: string } | null; tab?: string | null } | null;
  touched?: { images: string[]; frames: string[]; looks: string[] } | null;
  undo?: { ops: Array<Record<string, unknown>> } | null;
}

/** The saved-project list changed: a project was made, opened, saved,
 *  renamed, given a cover, deleted, restored or deleted for good, by anyone
 *  (backend main.py _broadcast_projects_changed). Projects lists again. */
export interface ProjectsChangedEvent {
  type: 'projectsChanged';
  change: 'created' | 'opened' | 'saved' | 'renamed' | 'cover' | 'deleted' | 'restored' | 'purged' | string;
  /** Null when several went at once (emptying Recently deleted). */
  projectId: string | null;
  /** change 'canvasHeld' / 'canvasHoldRefused' (review 5 of PR #199, M-3;
   * review 6, M-1): an agent's write held the waiting canvas aside (action
   * 'cleared' | 'replaced' | 'changed'), or was refused at the limit
   * ('clear' | 'replace' | 'change'); agent null when unnamed. `agentId` and
   * `color` (the agent's cursor's) make the Agent log row the agent's (N-3). */
  canvasHeld?: { action: string; agent: string | null; agentId?: string; color?: string;
    /** GM's rule (a): the person's canvas was saved first as this project,
     * untouched; `copy` when the agent's write changed a copy of it. */
    savedAs?: string; copy?: boolean;
    /** GM r15 on PR #199: the canvas already was that project, so it
     * was kept as it was (not "saved as its own project"). */
    kept?: boolean };
}

/** The settings changed (PUT /api/settings, a key's DELETE, the desktop
 *  credential bridge: backend main.py _broadcast_settings_changed), sent to
 *  the person's tabs only. No values travel: `keys` names the keys whose
 *  value changed, if any; the tab reads GET /api/settings again
 *  (store/settingsChangedSocket.ts). */
export interface SettingsChangedEvent {
  type: 'settingsChanged';
  keys?: string[];
  /** The writing tab's own id, when it sent one (lib/tabId.ts TAB_ID). */
  origin?: string;
}

/** The active project's pins, sent after graphSync and on every pin change. */
export interface CanvasPinsEvent {
  type: 'canvasPins';
  projectId: string | null;
  pins: Pin[];
}

export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'withdrawn' | 'expired' | 'invalidated';

/** One node's run cost: free or paid, with its list price when Nebula has one. */
export interface ProposalCost {
  /** The node's cost class (backend model_pricing.cost_class through
   * canvas_proposals.cost_for): `mayCost`, a key-billing route with the
   * person's key set (Idol with a Hugging Face token), and `plan`, a run on
   * the person's Krea plan, are never paid; `free` is a local node, a
   * key-billing route with no key or a sourced $0. */
  kind: 'free' | 'paid' | 'mayCost' | 'plan';
  provider: string | null;
  label: string;
  price?: { low: number; high: number } | null;
  /** A key-billing node's name and the account it may bill. */
  name?: string;
  account?: string;
}

/** Why a paid node leaves the total open (backend model_pricing.estimate_run
 * reasons), in the Run chip's kinds (runScope UnpricedReason): the Accept
 * chip writes the same reason lines (GM, PR #203 r17 item 4). */
export type ProposalCostReason =
  | { kind: 'noPrice' | 'cantRun' | 'awaitingInput' | 'sizeUnreadable' | 'plan' }
  | { kind: 'missingKey'; keys?: string[] }
  | { kind: 'leftOut'; plus?: string };

/** List-price total for a proposal's run (backend canvas_proposals.summarize_cost). */
export interface ProposalEstimate {
  currency: 'usd';
  low: number;
  high: number;
  /** Some paid node has no list price, or a cost the vendor doesn't fix up front. */
  open: boolean;
  unpriced: string[];
  plan: string[];
  plus: string[];
}

export interface ProposalPort {
  id: string;
  label: string;
  dataType: string;
}

/** A node a proposal's run reads that can't run here: no key, no Krea sign-in, a route that can't take it. */
export interface ProposalNotReady {
  ref: string;
  /** The canvas node's id; null for a node the proposal adds. */
  nodeId: string | null;
  name: string;
  /** "needs OPENAI_API_KEY in Settings > Providers" (node_readiness.instance_missing): find_nodes' words, for agents. */
  missing: string;
  /** The person's line (round 3f, node_readiness.instance_missing_line): "GPT Image 2 needs your
   *  OpenAI API key. Add it in Settings." Absent from a backend older than 3f. */
  person?: string;
  /** Why it can't run, for one node and for several (PR #203 round 15:
   *  node_readiness.instance_missing_reason, person_line.NOT_READY_PREDICATES):
   *  what follows the quoted name ("needs your OpenAI API key. Add it in
   *  Settings." / "need …"). The bar merges nodes by it. Absent for a route's
   *  own line and from an older backend. */
  reason?: NotReadyReason;
}

/** A not-ready reason's predicate, for one node and for several. */
export interface NotReadyReason {
  one: string;
  many: string;
}

/** An agent's proposed change (backend services/canvas_proposals.ProposalBook.view). */
export interface ProposalEdge {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  sourceName?: string;
  targetName?: string;
  targetLabel?: string;
}

export interface ProposalView {
  id: string;
  status: ProposalStatus;
  agent: { id: string; name: string; color: string; verified: boolean };
  note: string;
  projectId: string | null;
  /** Backend wall-clock milliseconds. */
  createdAt: number;
  expiresAt: number;
  nodes: Array<{
    ref: string;
    definitionId: string;
    /** The name the agent gave it (`rename`), or the model's name. */
    name: string;
    /** The model's name, sent only when the agent named the node. */
    model?: string;
    category: string;
    params: Record<string, unknown>;
    position: { x: number; y: number };
    cost: ProposalCost;
    runs: boolean;
    willRun: boolean;
    ports: { inputs: ProposalPort[]; outputs: ProposalPort[] };
  }>;
  /** `sourceName`, `targetName` and `targetLabel` are the panel's words for
   * each wire: “Prompt” → “Second take” · Prompt (GM - Design, PR #216 r3). */
  edges: ProposalEdge[];
  /** Wires Accept removes: a model change drops the ones its new model has
   * no port for (backend main._stage_proposal `drops`). */
  removedEdges?: ProposalEdge[];
  /** Each node it touches, by id or ref, with its canvas name. */
  names?: Record<string, string>;
  /** The backend's one count of changes, for the card, the Update and MCP:
   * each new node, wire, changed node and removed wire. */
  changeCount?: number;
  /** `name` is "Hero shot (n4)", for agents; `title` and `model` are the
   * card's words, "Hero shot" and "Krea 2" (no id). `inputsUpdated`: the
   * change sets the model param `key` to the model the node already has, so
   * its inputs are read again; `name` is that model's own name (GM - Design,
   * PR #216 r4 8: "Krea 2 · inputs updated"). Names follow renames while the
   * proposal is open. */
  params: Array<{ nodeId: string; name: string; title?: string; model?: string;
    inputsUpdated?: { key: string; name: string };
    changes: Record<string, { from: unknown; to: unknown }> }>;
  run: string[];
  cost: {
    paidRuns: number;
    /** Runs that may bill the person's own account (a mayBillWithKey route
     * with their key set: Idol with a Hugging Face token), never counted as
     * paid (GM, PR #203 r11 item 2), and who they are. Absent from a backend
     * before round 7 of PR #203. */
    mayCostRuns?: number;
    mayCost?: Array<{ name: string; account: string }>;
    /** Runs on the person's Krea plan, never counted as paid (GM, PR #203
     * r19 item 1: "2 paid · 1 on Krea plan"). Absent from an older backend. */
    planRuns?: number;
    freeRuns: number;
    estimate: ProposalEstimate | null;
    upTo: boolean;
    providers: string[];
    /** Each run node; `definitionId`: which node type, so a key-billing node's
     * class is read again with the keys set now (canvasProposals liveKeyBilling).
     * `name`, `model` and `billedTo` ("your Krea plan") are the plan line's
     * words (backend canvas_proposals.plan_line). */
    nodes: Array<ProposalCost & {
      ref: string; nodeId: string | null; missing?: string; definitionId?: string; reason?: ProposalCostReason;
      name?: string; model?: string; billedTo?: string | null;
    }>;
    /** Run nodes that can't run here as set up, when the proposal was made
     * (backend main._not_ready_nodes, in find_nodes' words). Accept still runs. */
    notReady?: ProposalNotReady[];
    /** Agents' placeholders (and what needs them) its run will skip, left out
     * of the counts above (backend main._proposal_cost, Q125 item 3). */
    pendingSkipped?: import('./pendingNodes').PendingSkipSummary;
    note: string;
  };
  references: string[];
  reason: string | null;
  idMap: Record<string, string> | null;
  runNodeIds: string[] | null;
  /** The card's plan line under the note, by node name: "Changes and runs
   * “Hero shot” · Krea 2 on your Krea plan · no list price" (backend
   * canvas_proposals.plan_line; agents read the same words). */
  plan?: string;
}

/**
 * Browser sockets only: exactly what Accept will write (canvas_proposals.person_values).
 * The view's values are cut for agents; these are what the person approves.
 */
export interface ProposalPersonValues {
  /** New node ref -> its proposed params. */
  nodes: Record<string, Record<string, unknown>>;
  /** Existing node id -> param key -> {from, to}. */
  params: Record<string, Record<string, { from: unknown; to: unknown }>>;
}

/** Browser sockets only: a new proposal plus the key that lets this canvas decide it. */
export interface ProposalOpenedEvent {
  type: 'proposalOpened';
  proposal: ProposalView;
  acceptKey: string;
  personValues?: ProposalPersonValues;
}

/** Browser sockets only, after graphSync: every open proposal with its key. */
export interface ProposalSyncEvent {
  type: 'proposalSync';
  proposals: Array<ProposalView & { acceptKey: string; personValues?: ProposalPersonValues }>;
}

export interface ProposalClosedEvent {
  type: 'proposalClosed';
  proposalId: string;
  status: Exclude<ProposalStatus, 'open'>;
  reason?: string | null;
  idMap?: Record<string, string>;
}

export type ExecutionEvent = (
  | { type: 'queued'; nodeId: string }
  | { type: 'executing'; nodeId: string; variant?: VariantScope | null }
  | { type: 'progress'; nodeId: string; value: number; variant?: VariantScope | null }
  | { type: 'executed'; nodeId: string; outputs: Record<string, PortValue>; batchOutputs?: Array<Record<string, PortValue>> | null; variant?: VariantScope | null; batchVariants?: VariantScope[] | null; notes?: string[] | null;
      /** Output ports the node left empty on purpose (port -> reason); wires from them are inactive. */
      withheld?: Record<string, string> | null }
  /** A gate upstream withheld this node's input, so it never ran (backend execution/gating.py). */
  | { type: 'skipped'; nodeId: string; reason: string; gateNodeId?: string | null }
  /** `person`: the handler's line for the person (error copy round 3c); `error` is the specific text agents keep. */
  | { type: 'error'; nodeId: string; error: string; retryable: boolean; category?: ErrorCategory; friendly?: string; person?: string | null; providerText?: boolean; provider?: string | null; variant?: VariantScope | null }
  /** `person`: each check's line for the card (error copy round 3e); `message` is the agents' text. */
  | { type: 'validationError'; errors: Array<{ nodeId: string; portId: string; message: string; person?: string | null }> }
  | { type: 'graphComplete'; duration: number; nodesExecuted: number; nodesSkipped?: number }
  | { type: 'graphCancelled' }
  | {
      type: 'executionStatus';
      status: 'cancelled' | 'completed' | 'failed';
    }
  | {
      type: 'providerRecovery';
      nodeId: string;
      resumeOperationId: string | null;
      existingWorldId: string | null;
      durable: boolean;
      warning: string | null;
    }
  | {
      type: 'providerStartAmbiguous';
      nodeId: string;
      kind: ProviderStartKind;
      message: string;
      durable: boolean;
    }
  | { type: 'streamDelta'; nodeId: string; delta: string; accumulated: string }
  | { type: 'streamPartialImage'; nodeId: string; partialIndex: number; src: string; isFinal: boolean }
  | { type: 'streamPartialSvg'; nodeId: string; partialIndex: number; svg: string; isFinal: boolean }
  | {
      type: 'graphSync';
      nodes: unknown[];
      edges: unknown[];
      empty: boolean;
      /** Explicit committed graph import; ordinary updates remain merges. */
      graphReplaced?: boolean;
      /** A reopen of the project already open (the person's, an agent's, the
       * boot's) kept its open proposals (GM r29 on PR #199, 3): with
       * graphReplaced, the tab keeps them and their held runs. */
      proposalsKept?: boolean;
      /** The backend process that sent it (a restart gives a new one). */
      bootId?: string;
      /** Existing nodes this change put somewhere new; the canvas takes their positions. */
      moved?: string[];
      /** The person's canvas finished an agent's arrange: not an edit, it joins
       * the agent's undo step (graphStore foldFinishedArrange). */
      arranged?: { id: string; nodeIds: string[] };
      activeProjectId?: string | null;
      workspaceRevision?: string;
      /** Grows with each sync, in the order Nebula read the graph; each
       * socket gets them in that order. A restore's or node delete's answer
       * names its own sync's (graphStore whenSynced; PR #205 review 8). */
      syncSeq?: number;
      /** Someone other than the person (an agent, a script) opened or made a
       * project: the canvas follows and offers the way back. */
      projectSwitch?: ProjectSwitch;
      providerRecoveries?: ProviderRecoveryCheckpoint[];
      providerStartAmbiguities?: ProviderStartAmbiguity[];
      executionStatuses?: ExecutionStatusResult[];
    }
  | AgentPresenceEvent
  | AgentPresenceReplayEvent
  | AgentPresenceArrivalEvent
  | AgentPresenceLeaveEvent
  | AgentPresenceRetargetEvent
  | SocketDemotedEvent
  | AgentStatusEvent
  | AgentRunEvent
  | CanvasPinsEvent
  | AgentNotesEvent
  | StoredAssetChangedEvent
  | ProjectsChangedEvent
  | SettingsChangedEvent
  | ProposalOpenedEvent
  | ProposalSyncEvent
  | ProposalClosedEvent
  | AssetProposalOpenedEvent
  | AssetProposalSyncEvent
  | AssetProposalClosedEvent
  | QuestionsOpenedEvent
  | QuestionsSyncEvent
  | QuestionsClosedEvent
  | PersonThreadEvent
  | ChannelListenersEvent
  | SocketReconnectedEvent
) & { runId?: string };

type EventHandler = (event: ExecutionEvent) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Set<EventHandler> = new Set();
  /** Run before `handlers` (see subscribeFirst). */
  private firstHandlers: Set<EventHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private path: string;
  private connecting = false;
  private connectRun = 0;
  private forceDiscoveryOnReconnect = false;
  /** A socket has opened before, so the next open is a reconnect. */
  private everOpened = false;
  /** The socket the server promoted as the person (its person-only
   * `proposalSync` came, which the backend sends on a verified hello only). */
  private promoted: WebSocket | null = null;
  /** The tokens each socket's hellos carried, oldest first, one entry per hello, so a refusal
   * drops exactly the token of the hello it answers (Justin, 2026-10-31). A socket can carry two
   * hellos: a link taken while the first hello's answer is on its way says hello again, and the
   * server answers hellos in order, one answer each (`personRequired`, or the promote's
   * `proposalSync`). Kept in memory only, never logged. */
  private helloTokens = new WeakMap<WebSocket, string[]>();

  constructor(path: string) {
    this.path = path;
    // A person link pasted into this open tab: say hello on the open socket
    // if it is that backend's, otherwise reconnect to the backend it pins.
    if (typeof window !== 'undefined') onPersonConnected(() => this.personConnected());
    // A page back from the back/forward cache whose id a copy took moves to
    // a new one (lib/tabId.ts): the open socket says the kept state again
    // under it (review 21 LOW-1 on PR #199).
    onTabIdRekeyed(() => { void tabIdReady().then(() => this.sayKeptAgain()); });
  }

  private sayKeptAgain(): void {
    const socket = this.ws;
    if (!this.keptEdits || !socket || this.greeted !== socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'keptEdits', kept: true, tab: TAB_ID }));
  }

  private sayHello(socket: WebSocket, url: string): void {
    // Never under an id the page doesn't hold yet (review 21 LOW-1 on PR
    // #199): the hello and what follows it name this tab.
    const hello = (personToken: string | null | undefined) => {
      if (!personToken) {
        reportPersonRequired();
        // No hello, so this socket gets the agents' form: numbered cursors
        // from before (a token forgotten after a second 401) leave, as on a
        // refused hello (GM - Design, PR #211 review 4, item 4).
        if (this.ws === socket) this.dispatch({ type: 'socketDemoted' });
        return;
      }
      if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
        const sent = this.helloTokens.get(socket) ?? [];
        sent.push(personToken);
        this.helloTokens.set(socket, sent);
        socket.send(JSON.stringify({ type: 'hello', personToken }));
        // After the hello on the same socket, so the backend reads it from
        // the person's promoted socket (it ignores it from any other).
        this.greeted = socket;
        this.sendViewing(socket);
      }
    };
    const token = personTokenForSocket(url);
    if (tabIdConfirmed()) void token.then(hello);
    else void Promise.all([token, tabIdReady()]).then(([personToken]) => hello(personToken));
  }

  /** The project this tab shows on its canvas because the person opened it
   * there themselves (null: none, Projects home, or a project the tab
   * reached by following an agent's switch), as the person's tab says it to
   * the backend: the person's own open ends the protection of a project
   * filed from their waiting canvas (GM r13 on PR #199, 1). Sent after every
   * hello, and on change, with `openedBy: 'person'`; undefined until the
   * store says it. */
  private viewing: string | null | undefined = undefined;
  private greeted: WebSocket | null = null;
  /** The person's own acts not yet said on a promoted socket (GM r13, 1):
   * their open of the project already loaded (no request goes out for it)
   * and their first own edit in a project. Each is said once. */
  private personActs: { type: 'personOpen' | 'personInput'; projectId: string }[] = [];

  setViewing(projectId: string | null): void {
    if (this.viewing === projectId) return;
    this.viewing = projectId;
    if (this.ws) this.sendViewing(this.ws);
  }

  /** Whether this tab keeps edits Nebula couldn't save after a restore
   * (GM r15 on PR #199): the backend refuses agents' canvas writes and
   * project switches meanwhile (409 canvas_kept_in_tab, GM r16). Said on
   * the promoted socket after every hello, and on change, with this tab's
   * id (X-Nebula-Tab): the person's kept save passes the project limit
   * only from a tab Nebula knows keeps edits. */
  private keptEdits = false;

  setKeptEdits(kept: boolean): void {
    if (this.keptEdits === kept) return;
    this.keptEdits = kept;
    const socket = this.ws;
    if (socket && this.greeted === socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'keptEdits', kept, tab: TAB_ID }));
    }
  }

  /** One of the person's own acts in `projectId`, said on the person's
   * promoted socket (now, or after its next hello). */
  notePersonAct(type: 'personOpen' | 'personInput', projectId: string): void {
    this.personActs = [...this.personActs.filter((act) => act.type !== type), { type, projectId }];
    if (this.ws) this.sendViewing(this.ws);
  }

  private sendViewing(socket: WebSocket): void {
    if (this.greeted !== socket || this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    if (this.keptEdits) socket.send(JSON.stringify({ type: 'keptEdits', kept: true, tab: TAB_ID }));
    if (this.viewing !== undefined) {
      socket.send(JSON.stringify(this.viewing === null ? { type: 'viewing', projectId: null }
        : { type: 'viewing', projectId: this.viewing, openedBy: 'person' }));
    }
    const acts = this.personActs;
    this.personActs = [];
    for (const act of acts) socket.send(JSON.stringify(act));
  }

  private personConnected(): void {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    void personTokenForSocket(socket.url).then((personToken) => {
      if (this.ws !== socket) return;
      // GM r29 item 3 (fix round 19): the backend ignores a second hello on a
      // socket it already promoted, so a link taken in then (the same link
      // reopened) reconnects, and the new socket's hello is what the server
      // promotes, or refuses.
      if (personToken && this.promoted !== socket) this.sayHello(socket, socket.url);
      else socket.close(); // onclose reconnects, now to the pinned backend
    });
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.connecting) return;

    this.connecting = true;
    const run = ++this.connectRun;

    const forceDiscovery = this.forceDiscoveryOnReconnect;
    backendWebSocketUrl(this.path, { forceDiscovery })
      .then((url) => {
        if (run !== this.connectRun) return;
        this.connecting = false;
        const socket = new WebSocket(withTabClaim(url));
        this.ws = socket;

        socket.onopen = () => {
          this.forceDiscoveryOnReconnect = false;
          console.log('[ws] connected');
          // Say hello as the person on every (re)connect: only then does this
          // socket get proposal accept keys. No token, no hello.
          this.sayHello(socket, url);
          const reconnected = this.everOpened;
          this.everOpened = true;
          if (reconnected) {
            try {
              this.dispatch({ type: 'socketReconnected' });
            } catch (err) {
              console.error('[ws] a reconnect handler failed:', err);
            }
          }
        };

        socket.onmessage = (event: MessageEvent) => {
          try {
            const parsed = JSON.parse(event.data) as ExecutionEvent | { type: 'personRequired' };
            if (parsed.type === 'personRequired') {
              // The server refused this socket's hello: demoted (GM r29 item 3).
              if (this.promoted === socket) this.promoted = null;
              // Justin, 2026-10-31: that refusal is the backend saying the token this hello
              // carried is invalid, so the tab drops it (lib/personSession, with its guards).
              // This refusal answers the oldest hello still unanswered, so only its token can drop.
              dropRefusedPersonToken(this.helloTokens.get(socket)?.shift() ?? null);
              reportPersonRequired();
              if (this.ws === socket) this.dispatch({ type: 'socketDemoted' });
              return;
            }
            // GM r29 item 3: the person-only proposalSync comes on promote
            // only (backend websocket_endpoint), by whatever path the hello
            // came: a new link, the same link again, a reconnect, the desktop
            // app's token. The hold and the banner follow it.
            // The promote answers a hello too: it takes that hello's entry, so a later answer
            // on this socket lines up with its own hello.
            if (parsed.type === 'proposalSync') this.helloTokens.get(socket)?.shift();
            const promotedNow = parsed.type === 'proposalSync' && this.ws === socket;
            if (promotedNow) {
              this.promoted = socket;
              notePersonPromoted();
            }
            this.dispatch(parsed);
          } catch (err) {
            console.error('[ws] failed to parse message:', err);
          }
        };

        socket.onclose = () => {
          if (this.promoted === socket) this.promoted = null;
          this.forceDiscoveryOnReconnect = true;
          console.log('[ws] disconnected, reconnecting in 3s...');
          this.scheduleReconnect();
        };

        socket.onerror = (err) => {
          console.error('[ws] error:', err);
          this.ws?.close();
        };
      })
      .catch((err) => {
        if (run !== this.connectRun) return;
        this.connecting = false;
        this.forceDiscoveryOnReconnect = true;
        console.error('[ws] backend discovery failed:', err);
        this.scheduleReconnect();
      });
  }

  disconnect(): void {
    this.connectRun += 1;
    this.connecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  /** Like subscribe, but the handler sees each event before ordinary ones.
   * The project coordinator needs the canvas as it was before a graphSync
   * replaces it (an agent switched projects), and the graph store subscribes
   * first, at module load. */
  subscribeFirst(handler: EventHandler): () => void {
    this.firstHandlers.add(handler);
    return () => {
      this.firstHandlers.delete(handler);
    };
  }

  private dispatch(event: ExecutionEvent): void {
    for (const handler of [...this.firstHandlers, ...this.handlers]) {
      handler(event);
    }
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}

export const wsClient = new WebSocketClient('/ws');
