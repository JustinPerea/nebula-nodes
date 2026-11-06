import { create } from 'zustand';
import { hasUnsavedSceneEdits, releaseKeptCanvas, setReplacedCanvasKeeper, useGraphStore } from './graphStore';
import { isCanvasKept, subscribeKeptCanvas } from '../lib/keptCanvas';
import { useUIStore } from './uiStore';
import { useCreateDraftStore } from './createDraftStore';
import { fetchCLIGraph } from '../lib/api';
import { canonicalBackendAssetUrls } from '../lib/backend';
import { normalizeRuntimeMediaParams, type SavedEditsFile } from '../lib/graphFileShared';
import { projectSizeBytes } from '../lib/projectSize';
import { GRAPH_PARAMS_VERSION } from '../lib/savedParamsUpgrades';
import { getProjectContext } from '../lib/projectContext';
import { currentProjectOf, publishOpenProject } from '../lib/currentProject';
import { holdsPersonCredential } from '../lib/personSession';
import { tabWord } from '../lib/tabWord';
import { onParamsOutdated } from '../lib/paramsOutdated';
import { wsClient } from '../lib/wsClient';
import type { ProjectSwitch } from '../lib/wsClient';
import { onPersonInput } from '../lib/personInput';
import { isOwnEcho, type EditOrigin } from '../lib/canvasUndo';
import { TAB_ID } from '../lib/tabId';
import { holdCommonsExits, holdProjects } from '../lib/commonsUnsaved';
import { isBackendOffline, subscribeBackendConnection } from '../lib/backendConnection';
import { failureDetails } from '../lib/errorCopy';
import type { OpenHold, ReopenHold, ReopenHoldPlace } from '../lib/reopenHold';
import type { CatalogRestore, ProjectSnapshot, ProjectSummary, SavedProject, TrashedProject } from '../lib/projects';
import { agentClosedLine, DEFAULT_PROJECT_LIMIT, LATEST_EDITS_KEPT, RELOAD_TO_CONTINUE, RESTORE_COPY_FALLBACK_KEPT } from '../components/projects/restoreCopyCore';
import type { CanvasLimitContext } from '../components/projects/catalogRestoreCopy';
import { withRestoreCopy } from '../components/projects/restoreCopyLoader';
import { flowsNow, projectFlowsModule, type ProjectFlows } from './projectFlowsLoader';

/** The canvas kept in this tab (GM r15 on PR #199; review 11, HIGH-1):
 * Nebula restored its project list, or an agent's write closed the project
 * the tab showed, before the tab's latest edits were saved. The line shows
 * on the canvas until [Save as a project] files them; the person can keep
 * typing meanwhile. `sourceId`/`sourceName`: the project the edits were
 * made in (the recovered copy is named for it). `lead`: GM r14, 3's first
 * sentences for an agent's write (null for a restore, whose line is
 * RESTORED_LIST_UNSAVED). `error`: the last save's failure, shown with it. */
export interface KeptEdits {
  sourceId: string; sourceName: string; lead: string | null; saving: boolean; error: string | null;
  /** Review 14 (kept-hold LOW-1): [Discard edits] is on its way. Save and
   * Discard share one busy state: each waits while either runs. */
  discarding?: boolean;
  /** GM r24 (b): the last save was refused for the project limit or the
   * storage cap, which the person fixes by deleting: the notice offers
   * [Choose a project to delete] while this is set and the line shows. */
  chooseToDelete?: 'projects' | 'storage' | null;
}

/** The kept line as the notice shows it. */
export function keptEditsLine(kept: KeptEdits): string {
  return kept.lead ? `${kept.lead} ${LATEST_EDITS_KEPT}` : RESTORED_LIST_UNSAVED;
}

/** An agent (or a script) opened or made a project and this tab followed it.
 * Shown as a toast with the way back. */
export interface ProjectSwitchNotice {
  /** The agent's name; null for an unnamed script or CLI call. */
  actorName: string | null;
  created: boolean;
  projectName: string;
  previousProjectId: string | null;
  previousProjectName: string | null;
  /** This tab's last unsaved changes couldn't go into the previous project,
   * so they were kept as a recovered copy instead. */
  keptCopy: boolean;
}

/**
 * What Projects' "Try again" does for the failure it shows (error copy round
 * 3b, GM - Design: "make Retry redo the failed action, never a different one.
 * If that's more than a small change, hide Retry for those failures instead.").
 * Each action records itself and what it needs to run again; a refusal the
 * same request would get again records nothing (no Try again). `load`: read
 * the saved projects again, as startup does (a failed load, a stop, a
 * conflict); `full` when that only reloads (the line says so and keeps its
 * whole reason), `reopen` when it then finishes an open whose reply was lost.
 */
export type ProjectRetry =
  | { action: 'load'; full?: boolean; reopen?: string }
  | { action: 'list' }
  | { action: 'save' }
  | { action: 'open'; id: string }
  | { action: 'create'; name?: string; then?: () => Promise<void> }
  | { action: 'rename'; id: string; name: string }
  | { action: 'delete'; id: string }
  | { action: 'restore'; id: string }
  | { action: 'purge'; id: string }
  | { action: 'emptyTrash'; ids: string[] }
  | { action: 'cover'; id: string; url: string | null }
  /** GM r12 on PR #199, 1: the edits a restore stopped, kept in this tab,
   * saved as their own "Recovered <name>" project ([Save as a project]). */
  | { action: 'saveRecovered' }
  /** GM r9 decision 1: [Reload Nebula] after an update, with the edits kept
   * in their recovered copy; the reload opens it. */
  | { action: 'reloadForUpdate'; version: number | null }
  /** GM r29 on PR #199, 1: Nebula's own reopen that this tab couldn't
   * follow: [Open “Delta”] opens that project. */
  | { action: 'openFollowed'; id: string; name: string }
  /** GM r24 (c), PR #199 round 25: a flow's chunk (store/projectFlows) didn't
   * load: Try again loads it and redoes the press (`redo`). */
  | { action: 'part'; name: string; again: () => unknown };

/** GM r12 item 5: where an update's recovered copy went, when the reload
 * couldn't open it: a neutral notice (the restored copy's notice's look) with
 * × to close; a copy in Recently deleted also offers [Restore]. */
export interface CopyNotice {
  line: string;
  restore: { id: string; name: string } | null;
  /** GM #198 r22 Q2: [Open] for a recovered copy that is in the list. */
  open?: { id: string; name: string } | null;
}

/** What the Projects screen offers beside its error: 'redo' (Try again
 * redoes the failure, so the reason is GM's short line), 'reload' (Try again
 * reloads the saved projects, as the line says; the whole line stays),
 * 'save' (GM r12 on PR #199, 1: [Save as a project] after a restore stopped
 * this tab's edits; the whole line stays), 'reloadNebula' ([Reload Nebula]
 * after an update) or 'none' (no button; the whole line). */
export type ProjectRetryOffer = 'redo' | 'reload' | 'save' | 'none' | 'reloadNebula' | 'openFollowed' | 'partLoad';

/** PR #204 round 11: Try again redoes a person-only action ("Delete forever", "Empty":
 * require_person), so it locks on a tab that isn't connected as the person. */
export function projectRetryPersonOnly(state: { errorRetry: ProjectRetry | null }): boolean {
  return state.errorRetry?.action === 'purge' || state.errorRetry?.action === 'emptyTrash';
}

export function projectRetryOffer(state: { error: string | null; errorRetry: ProjectRetry | null }): ProjectRetryOffer {
  if (!state.error || !state.errorRetry) return 'none';
  if (state.errorRetry.action === 'saveRecovered') return 'save';
  if (state.errorRetry.action === 'reloadForUpdate') return 'reloadNebula';
  if (state.errorRetry.action === 'openFollowed') return 'openFollowed';
  if (state.errorRetry.action === 'part') return 'partLoad';
  return state.errorRetry.action === 'load' && state.errorRetry.full ? 'reload' : 'redo';
}

/** The text behind the Projects error line's collapsed Details toggle: a
 * person-only refusal's own words, written for agents (GM - Design, Q116 a:
 * "The agents' text stays behind Details."), only while the line it was
 * written for is still the one showing. */
export function projectErrorDetails(state: { error: string | null; errorDetails: ProjectErrorDetails | null }): string | null {
  return state.error !== null && state.errorDetails?.line === state.error ? state.errorDetails.raw : null;
}

/** Details for one error line: the line it belongs to, so a later line
 * (set anywhere, by any action) never shows them. */
export interface ProjectErrorDetails { line: string; raw: string }
export function detailsFor(line: string, error: unknown): ProjectErrorDetails | null {
  const raw = failureDetails(error);
  return raw ? { line, raw } : null;
}

export interface ProjectState {
  screen: 'home' | 'workspace';
  initialized: boolean; loading: boolean; busy: boolean;
  projects: ProjectSummary[]; activeProject: ProjectSummary | null;
  /** Recently deleted, newest first. Restorable until each entry's purgeAt. */
  trash: TrashedProject[];
  /** The project the Undo toast offers to bring back (its Undo may pass the
   * project limit: Justin, 2026-10-29). */
  lastDeleted: { id: string; name: string } | null;
  /** How many projects the list may hold (the listing's `projectLimit`), for
   * the lines that name it. */
  projectLimit: number;
  /** Nebula restored a damaged project list (backend catalog restore): the
   * Projects home notice, until the person closes it with ×. */
  catalogRestore: CatalogRestore | null;
  /** The person's ×: hides the notice and tells the backend not to list it again. */
  dismissCatalogRestore: () => void;
  /** The live canvas isn't a project and the list had no room to save it
   * (the listing's `canvasNotFiled`): the Projects home's waiting line. */
  canvasNotFiled: { reason: 'projects' | 'storage'; projectLimit?: number; canvases?: CanvasLimitContext['canvases']; deletes?: number | null } | null;
  /** Held canvases that couldn't be read (the listing's
   * `canvasHeldUnreadable`, review 6, L-1): the person's line. */
  canvasHeldUnreadable: { count: number | null; at?: string } | null;
  /** The person's × on that line (GM r9: a one-time report): hides it and
   * tells the backend not to list it again. */
  dismissCanvasHeldUnreadable: () => void;
  /** A waiting canvas was saved as this project (the listing's
   * `canvasSaved`): GM's toast, shown once per tab. `another`: a restore
   * notice named a canvas before it ("Another canvas…"). */
  canvasSaved: { id: string; name: string; overSaveLimit?: boolean; another?: boolean;
    filed?: { id: string; name: string; overSaveLimit?: boolean }[] } | null;
  dismissCanvasSaved: () => void;
  /** The project [Save as a project] saved this tab's edits as (GM r12 on
   * PR #199, 1): its toast names it. */
  editsRecoveredAs: FiledCopy | null;
  dismissEditsRecovered: () => void;
  /** GM r14 on PR #199, 3: the toast on Projects home after an agent's
   * write closed the project this tab showed ("Codex cleared the canvas. “X”
   * is kept as its own project."), so the tab never goes home silently. */
  agentClosedNote: { id: string; text: string } | null;
  dismissAgentClosedNote: () => void;
  /** The canvas kept in this tab, waiting for [Save as a project]. */
  keptEdits: KeptEdits | null;
  /** [Save as a project] on the kept line: everything typed up to the click
   * goes into its own project, which then opens here with the saved toast. */
  saveKeptEdits: () => Promise<void>;
  /** GM r20 on PR #199: [Discard edits] on the kept line, after its
   * confirm: the tab loads the project's saved state (or, when the restored
   * list doesn't hold it, goes to Projects home, whose restore notice says
   * where it is), leaves kept mode and its Undo, and says "Discarded the
   * kept edits." */
  discardKeptEdits: () => Promise<void>;
  workspaceRevision: string; error: string | null;
  /** What `error`'s Details toggle holds, for that line (projectErrorDetails). */
  errorDetails: ProjectErrorDetails | null;
  /** What Try again does for `error`; null hides it (projectRetryOffer). */
  errorRetry: ProjectRetry | null;
  /** The last failed save's own line, for the canvas's "Save failed · Retry". */
  saveError: string | null;
  /** 'paused': the project is over the save limit (Q118), so nothing is
   * sent until it is trimmed (savePaused). */
  saveStatus: 'saved' | 'saving' | 'unsaved' | 'error' | 'paused'; dirty: boolean;
  /** Saving is paused because the open project is over the 16 MiB save
   * limit (Q118): its size as the save check counts it, kept current as it
   * changes. Null otherwise. */
  savePaused: { bytes: number } | null;
  /** The one region notice for this state (GM's "Saving paused. …", the
   * Load graph line, then "Saving again. …"); `action`: it offers "See
   * what's large". A new id is a new notice. */
  sizeNotice: { id: number; text: string; action: boolean } | null;
  /** The "what's large" panel is open. */
  sizePanelOpen: boolean;
  openSizePanel: () => void;
  closeSizePanel: () => void;
  dismissSizeNotice: () => void;
  /** Load graph opened `fileName`: over the limit, GM's Load graph line and
   * the paused state. */
  noteLoadedGraph: (fileName: string, asNewProject?: boolean) => void;
  /** The panel's "Download a copy": the open project's canvas as a plain
   * .nebula file, so nothing is lost while saving is paused. */
  downloadProjectCopy: () => Promise<void>;
  /** The last switch this tab followed (an agent's), for the toast. */
  switchNotice: ProjectSwitchNotice | null;
  /** Nebula's verdict on replacing the open canvas now (lib/reopenHold):
   * what a reopen in place would be refused for. */
  openHold: OpenHold | null;
  /** The held-reopen line's World Labs forms, by the control that clears
   * it (GM r32, 2): the Stop form is the canvas notice. */
  heldReopenLine: { id: string; line: string; place: ReopenHoldPlace } | null;
  /** The person closed the held-reopen line's callout. */
  dismissHeldReopenLine: () => void;
  /** A stale tab's unsaved edits that Nebula refused for good as a recovered
   * project (too large, say): the Projects screen shows GM's "Couldn't save
   * your edits." with this reason, and offers to download them or continue
   * without them (Q116 a). Null otherwise. `downloadFailed`: the last
   * download couldn't be written, so the screen says GM's line 2 instead of
   * the reason, with the same two choices. `keptIn`: the edits are the open
   * project's own live canvas (the person's Open or New project, or an
   * agent's switch, while saving was paused), and the backend's switch keeps
   * its nodes, connections and settings in that project, named here, so "Continue
   * without them" loses only what only this tab had; the confirm says so. */
  /** `agentOpening`: an agent's switch left the project (GM, 2026-10-24:
   * "{agent} is opening “{name}”." above the screen's lines). */
  /** `downloadTooBig`: the last download was past the browser's string cap
   * (GM, 2026-10-25: "Couldn't download your edits." / "It's too big to
   * download in a browser."), not a write that failed. */
  unsavedEdits: { reason: string; downloadFailed?: true; downloadTooBig?: true; keptIn?: string;
    agentOpening?: { agent: string; projectName: string } } | null;
  /** The file those edits were downloaded as, for GM's line after it, and
   * whether Load graph can open it (a copy past its limits can't). */
  editsSavedAs: SavedEditsFile | null;
  /** GM r12 item 5: an update's recovered copy the reload couldn't open. */
  copyNotice: CopyNotice | null;
  /** Its [Restore]: restore the copy from Recently deleted and open it. */
  restoreCopyNotice: () => Promise<void>;
  /** Its ×. */
  dismissCopyNotice: () => void;
  /** Its [Open] (GM #198 r22 Q2): open the recovered copy it names. */
  openCopyNotice: () => Promise<void>;
  /** "Download your edits": write the held copy as a .nebula file, then load
   * the projects. A cancelled save picker keeps the two choices. */
  downloadUnsavedEdits: () => Promise<void>;
  /** "Continue without them", once the person confirmed: drop the held copy
   * (nothing is sent) and load the projects. */
  continueWithoutEdits: () => Promise<void>;
  dismissSwitchNotice: () => void;
  /** Back to the project that was open before the switch in switchNotice. */
  switchBack: () => Promise<void>;
  /** Pin one of a project's images as its card cover, or null for automatic. */
  pinCover: (id: string, url: string | null) => Promise<void>;
  initialize: () => Promise<void>;
  /** `notPersons`: shown for something that isn't the person's own open of
   * the project (a `#moodboard/<id>` link that waited while an agent's switch
   * came: review 11 of PR #199): the loaded project shows, and nothing
   * says the person opened it. */
  open: (id: string, options?: { notPersons?: boolean }) => Promise<void>;
  /** `then` runs once the new project is open (Q120: a Load graph file over
   * the limit loads into it), after #178's screen when saving was paused with
   * unsaved edits; never when the create doesn't land. */
  createProject: (name?: string, then?: () => Promise<void>) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** `from` 'undo': the Undo toast's button (a refusal then takes the toast's place). */
  restore: (id: string, from?: 'undo') => Promise<void>;
  purge: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  dismissUndo: () => void;
  goHome: () => Promise<void>;
  flush: () => Promise<void>;
  /** Projects' Try again: redoes the action in errorRetry. */
  retry: () => Promise<void>;
  /** The canvas's "Save failed · Retry": saves, whatever Projects shows. */
  retrySave: () => Promise<void>;
}

let initializing: Promise<void> | null = null;
let saveQueue: Promise<unknown> = Promise.resolve();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** The person's edits save this long after the last one, so typing and
 * dragging go as one save. */
const AUTOSAVE_MS = 600;
/** A change the canvas made itself (saveCanvasChange) saves quietly once the
 * canvas has held still this long, so a fit's frames go as one save. */
const CANVAS_SETTLE_MS = 300;
let canvasTimer: ReturnType<typeof setTimeout> | null = null;
/** Count the changes the save label shows: the person's own (markDirty) and
 * someone else's edits that reached this tab (saveForeignEdit). A save
 * records both when it captures the canvas, so once it lands it can tell who
 * changed what is still unsaved, and a save with neither since the last one
 * landed is only the canvas's own and leaves "Saved" alone. */
let personChanges = 0;
let foreignEdits = 0;
let savedPersonChanges = 0;
let savedForeignEdits = 0;
/** Set while the graph store applies a graphSync carrying someone else's
 * edit ('edit') or the layout the canvas wrote for an agent's nodes
 * ('canvas'); what changes meanwhile is that sync's (applyingSync), and
 * syncSaving says the edit's save is already asked for. */
let syncBeingApplied: 'edit' | 'canvas' | null = null;
let syncSaving = false;
let lastSaved = '';
/** The canvas the save under way is sending. While it is out, a change is
 * measured against it, not the last save that landed: React Flow measuring an
 * agent's new nodes gives the graph a new nodes array, and next to the older
 * save that read as "Unsaved changes" though nothing saved had changed. */
let inFlight: string | null = null;
/** The canvas as of the last change looked at. A store update that leaves
 * what the project saves as it was (React Flow measuring nodes, selection)
 * isn't a change at all, so it neither reads as unsaved nor restarts a wait,
 * even while an earlier change is still waiting to save. */
let lastSeen = '';
let applying = false;
/** The view the open project was saved with. A tab that isn't connected as
 * the person (an agent's browser) keeps its own zoom and pan while open but
 * saves this one, so looking around there is never an unsaved edit; the
 * backend keeps the stored view for its saves anyway (design-canvas gap 19). */
let projectViewport: ProjectSnapshot['viewport'] = null;
/** A stale tab's unsaved work, waiting to be saved as a recovered project.
 * `projectName` names the download if Nebula refuses it for good; `held` is
 * set then, and from that moment nothing sends it again: only the person's
 * choice on the Projects screen lets go of it (Q116 a). */
export interface PendingRecovery {
  sourceProjectId: string; snapshot: ProjectSnapshot; recoveryId: string; paramsVersion: number;
  projectName: string; held: boolean;
}
let pendingRecovery: PendingRecovery | null = null;
/** The open Try again was finishing when the held edits stopped it (an Open
 * whose answer was lost), or the person's own Open of another project while
 * saving was paused: done once the person has chosen. */
let heldEditsReopen: string | undefined;
/** The person's New project while saving was paused, done the same way. */
let heldEditsCreate: { name?: string; then?: () => Promise<void> } | undefined;
/** How many bytes more the backend counted than this tab did, from its last
 * 413 for the size (Q118). The two measures are the same by test, so this
 * is 0 unless they ever differ; then the canvas pauses on the backend's
 * number and doesn't send each change to be refused again. Cleared by a
 * save that lands and by loading a project. */
let sizeOffset = 0;
let sizeNoticeId = 0;
/** A save that would have ended the pause failed for another reason (a
 * dropped connection, a 5xx): the pause is dropped then, since the project
 * measured at the limit or under and the real problem is the failed save,
 * and the save that lands next still says GM's "Saving again" (review). */
let resumePending = false;
/** The person downloaded the held edits during a params-version stop: the
 * tab asks for its reload instead of reloading, so GM's line saying where
 * the file went stays on screen. */
let editsDownloaded = false;
/** The one-time param upgrades the canvas had when it was loaded. Every
 * project the backend returns is already upgraded to the backend's version,
 * and a project is applied only from a backend that reported this bundle's
 * GRAPH_PARAMS_VERSION (listing, create and open replies; a backend that
 * reports none is version 0 and is never loaded from). A stale tab's recovered
 * copy sends it, so the backend upgrades the copy from what the tab actually
 * holds rather than from its source project. */
let canvasParamsVersion = GRAPH_PARAMS_VERSION;
/** The backend's params version differs from this bundle's: the one handling
 * of it (recover once, then reload), shared by every report of it. */
let paramsVersionChange: Promise<void> | null = null;
/** Counts handlings of a params-version change. Retry starts a new one, so an
 * earlier handling whose recovered copy is answered after that is stale: it
 * must not stop, mark clean or relabel a tab Retry already moved on. */
let paramsHandling = 0;
/** Set when the tab reloads for a params upgrade, so the unsaved-changes
 * prompt doesn't stop a reload whose edits are already in a recovered copy. */
let reloadingForParams = false;
/** Projects lists again on every projectsChanged (another writer made,
 * renamed, saved or deleted a project). Off Projects it waits for goHome. */
let listingStale = false;
/** Bumped by every listing this tab applies, so an older reply never
 * replaces a newer list. */
let listingGeneration = 0;
/** A failed listing on Projects is tried again 1, 2, 4, 8 and 16 s later,
 * quietly; after that on focus, online or a socket reconnect. Off Projects
 * none is scheduled and a pending one sends nothing; goHome lists again with
 * a fresh count. */
let relistTimer: ReturnType<typeof setTimeout> | undefined;
let relistFailures = 0;
export function relistIfStale(): void {
  if (listingStale && useProjectStore.getState().screen === 'home' && !paramsVersionChange) { listingStale = false; relistNow(); }
}

/** The flows' listing, run once the chunk is in (a listing on Projects needs a
 * chunk that is already loaded, so this is a press the stub would run). */
function relistNow(): void { void runFlows('relist', (flows) => flows.relistProjects()); }
function paramsChangeNow(version: number | null): void { void runFlows('params', (flows) => flows.handleParamsVersionChange(version)); }
function syncNow(event: GraphSyncEvent, synthetic = false): void { void runFlows('sync', (flows) => flows.workspaceSync(event, synthetic)); }

/** Persist authoring and results, excluding React Flow measurements/selection
 * and transient credential/progress presentation. JSON gives each save its
 * own immutable copy, including nested Paper recipes and run history. Asset
 * links go back to the relative ones the backend gave (applyProject and run
 * results make them absolute for display): a World's are refused otherwise. */
export function captureProjectSnapshot(): ProjectSnapshot {
  const graph = useGraphStore.getState();
  const ui = useUIStore.getState();
  const draft = ui.createSessionId ? useCreateDraftStore.getState().drafts[ui.createSessionId] : null;
  const snapshot: ProjectSnapshot = {
    nodes: graph.nodes.map((node) => {
      const data = { ...node.data, params: normalizeRuntimeMediaParams(node.data.definitionId, node.data.params) };
      delete data.keyStatus;
      delete data.progress;
      delete data.streamingText;
      delete data.streamingPartials;
      delete data.streamingSvg;
      return { id: node.id, type: node.type, position: node.position, data };
    }),
    edges: graph.edges.map((edge) => ({
      id: edge.id, source: edge.source, target: edge.target,
      sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
      type: edge.type, data: edge.data,
    })),
    runHistory: graph.runHistory,
    viewport: holdsPersonCredential() ? ui.canvasViewport : projectViewport,
    createSessionId: ui.createSessionId,
    createDraft: draft ?? null,
  };
  return canonicalBackendAssetUrls(JSON.parse(JSON.stringify(snapshot)) as ProjectSnapshot);
}

export function summary(project: SavedProject): ProjectSummary {
  const { snapshot: _snapshot, ...metadata } = project;
  void _snapshot;
  return metadata;
}

/** The open project's size from its JSON text, as the backend counts it. */
export const measured = (text: string) => projectSizeBytes(null, text) + sizeOffset;

export type UIStateNow = ReturnType<typeof useUIStore.getState>;
/** What a window keeps through the person's reopen elsewhere, read when the
 * switch arrives (before its sync clears the view): the studio it is in and
 * the canvas view (review 21 LOW-2 and NIT-1, GM r36 item 5). */
export type KeptStudio = Pick<UIStateNow, 'viewMode' | 'editorTargetNodeId' | 'remotionEditorTargetNodeId'
  | 'cinemaEditorNodeId' | 'cinemaSelectedShotIds' | 'characterEditorId' | 'moodboardEditorId' | 'canvasViewport'>;

/** Set while followProjectSwitch loads a reopen this window keeps its view
 * through (review 20 LOW-3): applyProject leaves the panels and view mode,
 * and carries the studio and the viewport (carriedStudio). */
let keepWindowView: { renumbered: Record<string, string>; selected: string[]; inspected: string | null;
  studio: KeptStudio } | null = null;

/** Save a stale tab's unsaved work as an inactive recovered copy, once: the
 * recoveryId makes a retry of the same request idempotent, and afterwards the
 * captured canvas counts as saved, so a later conflict doesn't copy it again.
 * Every send of the copy goes through here (Projects' load and Try again, a
 * params-version stop, following an agent's switch). A refusal a retry can't
 * fix (a 4xx other than 408/429) holds it for the person (holdRefusedEdits)
 * and throws EditsRefused; once held, it is never sent again. */
/** The copy the last recovery made (a whole new project in Projects): GM's
 * failed-handoff line names it and opens it (round 20). */
/** The kept unload guard's returnValue (see the guard). */
const KEPT_UNLOAD_MARK = 'nebula-kept-unload-guard';
let lastRecoveredCopy: { id: string; name: string; sourceName?: string } | null = null;

/** The recovery id [Save as a project] sends for the kept canvas, kept
 * while the canvas is the same, so a retry of a save whose answer was lost
 * makes no second project. */
let keptRecovery: { fingerprint: string; recoveryId: string } | null = null;

// GM r20 on PR #199: kept mode never outlives its canvas. Whatever replaces
// it (graphStore's loads release the kept canvas) takes the kept line with it.
subscribeKeptCanvas(() => {
  if (isCanvasKept()) return;
  keptRecovery = null;
  if (useProjectStore.getState().keptEdits) useProjectStore.setState({ keptEdits: null });
  // GM r22 (2): the kept update line goes with kept mode, whatever ended it
  // (Save and Discard then handle the update themselves; any other end
  // leaves it to the next listing or sync, as before).
  if (isKeptUpdateLine(useProjectStore.getState().error)) useProjectStore.setState({ error: null, errorRetry: null });
});

/**
 * Review 14 of PR #199 (HIGH-1): the copy gave the nodes added while kept
 * backend ids (`renumbered`), and the tab loaded it, so every id it holds is
 * the copy's: the canvas and its wires come from the copy, kept Undo ended
 * with kept mode, and the open cleared the panels. What the person had
 * selected (and the Inspector's node) is selected again by its new id.
 */

/** The copy Save as a project filed, as the notices name it, with the line
 * for any connection its rules left out (GM r24: the second sentence of
 * whichever notice confirms the save; carried across the update's reload). */
export type FiledCopy = { id: string; name: string; dropped?: string };

/** GM r22 (2): an update seen while kept, handled when kept mode ends. */
let keptUpdate: { version: number | null } | null = null;

/** Review 14 (kept-hold LOW-4): why the open that would leave kept mode
 * failed, when activate's own catch kept it to itself (a 5xx, no answer). */
let leavingFailure: string | null = null;
/** Set while Discard's open runs (its failure goes to the kept line). */
let discardOpening = false;

/** A reload resets this module's state in the app; tests share one module, so
 * each test starts from this. A handling of a params-version change still in
 * flight from an earlier test is superseded, so its late answer writes nothing. */
/** The project the person opened in this tab themselves (their open or
 * create, here): the only screen whose `viewing` ends the protection of a
 * project filed from their waiting canvas (GM r13 on PR #199, 1; review 10,
 * HIGH-2). A project the tab reached by following an agent's switch, or
 * loaded for any other reason, is never it. */
let personOpenedId: string | null = null;
/** The project the person's first own edit was said for (`personInput`),
 * once per visit to it. */
let personInputSaidFor: string | null = null;

export const viewingOf = (state: ProjectState) => (state.screen === 'workspace' && state.activeProject
  && state.activeProject.id === personOpenedId ? state.activeProject.id : null);

export function resetProjectStoreForTests(): void {
  shownReopen?.stop(); shownReopen = null;
  stopHoldWatch?.(); stopHoldWatch = null; holdWatchers = 0; openHoldBasis = null; openHoldSeq += 1; lastHoldNow = null;
  quietReopenOf = null; keepWindowView = null;
  reloadLineCopy?.stop(); reloadLineCopy = null;
  personOpenedId = null;
  personInputSaidFor = null;
  syncedRestore = undefined;
  restoredSinceSync = false;
  syncedSaved = undefined;
  savedFromUnder = null;
  keptRecovery = null;
  keptUpdate = null;
  leavingFailure = null;
  discardOpening = false;
  releaseKeptCanvas();
  dismissedRestores.clear();
  dismissedHeldNotes.clear();
  loggedRestores.clear();
  followingSwitch = null;
  heldFollow?.stop(); heldFollow = null;
  initializing = null;
  saveQueue = Promise.resolve();
  cancelPendingSaves();
  lastSaved = '';
  inFlight = null;
  lastSeen = '';
  personChanges = foreignEdits = savedPersonChanges = savedForeignEdits = 0;
  syncBeingApplied = null;
  syncSaving = false;
  applying = false;
  projectViewport = null;
  pendingRecovery = null;
  lastRecoveredCopy = null;
  heldEditsReopen = undefined;
  heldEditsCreate = undefined;
  sizeOffset = 0;
  resumePending = false;
  editsDownloaded = false;
  canvasParamsVersion = GRAPH_PARAMS_VERSION;
  paramsVersionChange = null;
  paramsHandling += 1;
  reloadingForParams = false;
  clearTimeout(relistTimer);
  relistFailures = 0;
  listingStale = false;
}

/**
 * The copy the reload line names (GM r31 on PR #199, 4). Its name is fixed
 * before the line shows: Nebula filed the copy under it (POST
 * /api/projects/recover answered first), names in use are never given to
 * another copy, and the reload opens it by id. So the line keeps the name.
 * Only a rename or a delete of that copy before the reload could make it
 * false: the line then follows the copy's listed name, or, once the copy
 * leaves the list, ends at "…a recovered copy." The source form ("a
 * recovered copy of “Shot 7”") names what Nebula recorded at the recovery,
 * which a rename doesn't change.
 */
let reloadLineCopy: { id: string; name: string; sourceName?: string; line: string; stop: () => void } | null = null;

export const TAB = tabWord();
export const PARAMS_UPDATED = `Nebula was updated while this ${TAB} was open.`;
/** GM r22 (2), verbatim: the update's line while the canvas is kept. Save
 * as a project and Discard edits each reload the tab when done. */
export const KEPT_UPDATE_LINE = `${PARAMS_UPDATED} Save the kept edits as a project or discard them, and the ${TAB} reloads to use the update.`;
/** The same, when the tab can't reload by itself (it already reloaded once
 * for this version, or the versions need a rebuild or a restart): the
 * person reloads (GM r22, 2: "then reload the tab", for that path only). */
export const KEPT_UPDATE_RELOAD_LINE = `${PARAMS_UPDATED} Save the kept edits as a project or discard them, then reload the ${TAB} to use the update.`;
/** Whether `line` is the kept update line (either form): the kept notice
 * shows it, since the workspace has no other place for the store's error. */
export const isKeptUpdateLine = (line: string | null | undefined): line is string => line === KEPT_UPDATE_LINE || line === KEPT_UPDATE_RELOAD_LINE;

export function cancelPendingSaves(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  if (canvasTimer !== null) clearTimeout(canvasTimer);
  canvasTimer = null;
}

/** Whether a store update changed what the project saves (since the last
 * one looked at) to something not saved or being saved yet. `recheck` asks
 * only the second half: after a switch, rename or delete held the tab busy,
 * a change made meanwhile was seen but not yet marked. */
function unsavedChange(recheck = false): boolean {
  const state = useProjectStore.getState();
  if (applying || !state.initialized || !state.activeProject) return false;
  const now = JSON.stringify(captureProjectSnapshot());
  const changed = recheck || now !== lastSeen;
  lastSeen = now;
  return changed && now !== (inFlight ?? lastSaved);
}

/** The person's own change: "Unsaved changes", then a save once they have
 * paused for AUTOSAVE_MS. While the tab is busy (switching projects) it is
 * only counted; the switch saves first and looks again when it finishes. */
export function markDirty(recheck = false): void {
  if (!unsavedChange(recheck)) return;
  personChanges += 1;
  if (useProjectStore.getState().busy) return;
  // While saving is paused the header keeps saying so; the wait below
  // measures the change again.
  useProjectStore.setState({ dirty: true, saveStatus: useProjectStore.getState().savePaused ? 'paused' : 'unsaved' });
  if (saveTimer !== null) clearTimeout(saveTimer);
  // The person's save takes along a canvas change still settling: its quiet
  // save must not go first and cut the person's wait short.
  if (canvasTimer !== null) clearTimeout(canvasTimer);
  canvasTimer = null;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void useProjectStore.getState().flush().catch(() => { /* Visible retry state. */ });
  }, AUTOSAVE_MS);
}

/** Someone else's edit reached this tab (an agent's edit_canvas or `nebula
 * apply`, another window's, an outside app's). It came as one graphSync that
 * is already the whole change, coalesced where it was made, so there is
 * nothing to wait for: it reads "Saving…" from the moment it lands and saves
 * now, taking along anything of the person's still waiting. One save goes at
 * a time (saveQueue), and each captures the canvas when it starts, so a
 * second edit landing meanwhile saves next, newest state and all. A failed
 * save reads as one, and the unload prompt stays armed (dirty). */
function saveForeignEdit(): boolean {
  if (!unsavedChange()) return false;
  foreignEdits += 1;
  if (useProjectStore.getState().busy) return true;
  useProjectStore.setState({ dirty: true, saveStatus: useProjectStore.getState().savePaused ? 'paused' : 'saving' });
  // The save captures the canvas when it starts, after the whole sync is in.
  void useProjectStore.getState().flush().catch(() => { /* Visible retry state. */ });
  return true;
}

/** A change the canvas made itself: its camera after an agent's nodes land
 * (the fit, an arrange's reveal) or the layout it wrote for them. It isn't
 * the person's edit, so it never reads "Unsaved changes" and never restarts
 * or extends the person's autosave wait: a save already waiting takes it
 * along, and otherwise it saves quietly once the canvas holds still, the
 * label keeping what it says. Until then the unload prompt still guards it. */
function saveCanvasChange(): void {
  if (!unsavedChange() || useProjectStore.getState().busy) return;
  if (!useProjectStore.getState().dirty) useProjectStore.setState({ dirty: true });
  if (saveTimer !== null) return;
  if (canvasTimer !== null) clearTimeout(canvasTimer);
  canvasTimer = setTimeout(() => {
    canvasTimer = null;
    void useProjectStore.getState().flush().catch(() => { /* Visible retry state. */ });
  }, CANVAS_SETTLE_MS);
}

/** A change to what the project saves, from the graph or the camera: the
 * person's, unless it is part of a sync being applied (applyingSync). */
function noteChange(): void {
  if (syncBeingApplied === 'edit') {
    // Its save is asked for once; a later write of the same sync is only
    // looked at (lastSeen), so a measure after it isn't read as a new change.
    if (!syncSaving) syncSaving = saveForeignEdit();
    else unsavedChange();
  }
  else if (syncBeingApplied === 'canvas') saveCanvasChange();
  else markDirty();
}

/** A graphSync for the open project that is someone else's edit, or that
 * finishes an agent's arrange (the layout this or another canvas measured
 * and wrote: no `edit`, an `arranged` marker), is about to be applied: the
 * graph store does it next, in this same dispatch (wsClient hands every
 * handler the message at once), so what changes until this task's microtask
 * is that sync's, and saves the way its kind does (noteChange). Run results
 * and this tab's own echoes aren't tagged and stay the person's path. */
export function applyingSync(event: { edit?: EditOrigin; arranged?: unknown }): void {
  const kind = event.edit && !isOwnEcho(event.edit, TAB_ID) ? 'edit' : !event.edit && event.arranged ? 'canvas' : null;
  if (!kind) return;
  syncBeingApplied = kind;
  syncSaving = false;
  void Promise.resolve().then(() => {
    syncBeingApplied = null;
    syncSaving = false;
  });
}

/** The canvas placed its own first camera (on mount: React Flow's start, or
 * its fit of a project saved without a view). That isn't an edit: when it is
 * all that differs from the last save, it joins what counts as saved, so a
 * project just opened or followed reads "Saved"; the next real change saves
 * it along. When more differs (an agent's first nodes, which bring this fit
 * on a canvas that opened empty), it saves with that, as the canvas's own. */
function adoptCanvasCamera(before: ProjectSnapshot['viewport']): void {
  const snapshot = captureProjectSnapshot();
  if (lastSaved && JSON.stringify({ ...snapshot, viewport: before }) === lastSaved) lastSaved = lastSeen = JSON.stringify(snapshot);
  else saveCanvasChange();
}

/** Why the person's reopen in place of `id` can't go now (review 18
 * MEDIUM-2, GM r30 item 2; review 19 item 1). Nebula's own verdict first
 * (lib/reopenHold: the state its replacement guard would refuse the open
 * for, any project's World Labs records included), then this tab's own
 * holds Nebula can't see: a World Labs run whose status this tab lost
 * ('uncertain'), an ambiguity it lists that the verdict doesn't name (it
 * won't switch until its own notice's press), and its run, uploads or
 * Create work ('tabRun'). Null when it can go, or when it isn't a reopen
 * in place. */
export type { ReopenHold } from '../lib/reopenHold';
/** The table of lines (lib/reopenHoldLines) loads when a hold first arrives,
 * not with the entry chunk (review 21 LOW-1, the entry chunk's budget).
 * Nothing says a line before it is here: the Projects card shows none and
 * the canvas none until it loads (a local chunk, a moment), then the line
 * arrives as it always did. If the chunk can't load, no line shows and the
 * next hold tries again. */
let holdLines: typeof import('../lib/reopenHoldLines') | null = null;
/** The line for `hold` (lib/reopenHoldLines, the one table), once loaded
 * (loadReopenHoldLines); null before. */
export function heldLine(project: string, openId: string, hold: ReopenHold): string | null {
  return holdLines ? holdLines.reopenHoldLine(project, openId, hold) : null;
}

/** What this tab held when Nebula's verdict was read (verdictStillTrue). */
let openHoldBasis: { ambiguities: number; recoveries: number; executing: boolean } | null = null;
let openHoldSeq = 0;
/** Keeps the verdict current while something shows it (Projects, a held
 * line): a read on each change that can start or end a hold (a run, a
 * World Labs record, a node's settings), and every few seconds for what
 * another tab or Nebula itself changes. Only while the canvas holds a node
 * a reopen would give an id (nothing else is held). */
let holdWatchers = 0;
let stopHoldWatch: (() => void) | null = null;

/** The open project's held reopen, for the card's lock line on Projects:
 * null the moment the hold ends (GM r31, 2). */
let lastHoldNow: { id: string; line: string } | null = null;
export function reopenHoldNow(): { id: string; line: string } | null {
  const project = useProjectStore.getState().activeProject;
  const hold = project ? flowsNow()?.reopenHold(project.id) ?? null : null;
  // Before the lines are here, nothing is said (the load wakes this read).
  const line = project && hold ? heldLine(project.name, project.id, hold) : null;
  const next = project && line !== null ? { id: project.id, line } : null;
  // The same value keeps the same object (a stable snapshot for useSyncExternalStore).
  if (next?.id !== lastHoldNow?.id || next?.line !== lastHoldNow?.line) lastHoldNow = next;
  return lastHoldNow;
}

/** The line this tab put on the canvas after the person asked to reopen
 * (never during a run they didn't ask about). It follows the hold (GM r31,
 * 2; review 19 item 9): another hold's line, in that hold's place, when the
 * hold changes; gone the moment none is left, or another project opens, or
 * the person closes it. The Stop form is the canvas notice; the World Labs
 * forms are `heldReopenLine`, in the World Labs notice's box (GM r33, 6) or by
 * Run History (GM r32, 2). */
let shownReopen: { id: string; line: string; place: ReopenHoldPlace; stop: () => void } | null = null;
/** What a press that couldn't say its line gets back: the chunk's failure. */
export type ReopenSaid = { lines: unknown } | void;

/** The project whose reopen in place is being tried a second time, quietly
 * (activate's 409 with nothing holding). */
let quietReopenOf: string | null = null;

/** Restores this tab closed the notice of, or wrote the Agent log line for. */
export const dismissedRestores = new Set<string>();
/** Notes of held canvases that couldn't be read this tab closed (by `at`). */
export const dismissedHeldNotes = new Set<string>();
export const loggedRestores = new Set<string>();

/** What a listing says beside the projects: the restore notice, the live
 * canvas waiting to be saved, and a waiting canvas just saved (its toast
 * once per tab; a later listing that still carries it keeps it showing
 * until it is dismissed or times out). */
export type ListingNotices = Pick<ProjectState, 'catalogRestore' | 'canvasNotFiled' | 'canvasHeldUnreadable'> & { canvasSaved?: ProjectState['canvasSaved'] } & { projectLimit?: number } & { openHold?: OpenHold | null };

/** Load what the backend has open now (the listing and its active project).
 * Startup, Retry, and following an agent's switch all come through here. */
/** The last listing ran this bundle's params version (loadWorkspace). */
let backendParamsCurrent = false;

/** What the toast says when an agent (or a script) switched the open project.
 * GM's lines (2026-10-24; the project is on screen, so "made" already says it
 * opened): "Claude Code opened “{name}”. Edits saved as a copy." / "Claude
 * Code made “{name}”. Edits saved as a copy." / made with no copy: "Claude
 * Code made “{name}”." Opened with no copy is unchanged ("Claude Code opened
 * “{name}”."); round 4b: "A long name can still wrap. That's fine for a
 * toast." The agent's name is whatever the switch carries. */
export function switchMessage(notice: ProjectSwitchNotice): string {
  const who = notice.actorName ?? 'An outside app';
  const name = `“${notice.projectName}”`;
  const what = notice.created ? `made ${name}` : `opened ${name}`;
  return notice.keptCopy ? `${who} ${what}. Edits saved as a copy.` : `${who} ${what}.`;
}

/** The agent switch this tab is following, with every switch notice that
 * arrived while it waited (round 17 of PR #114, review 16 M1): offline, an
 * agent may switch again, or back, before the tab can follow. */
let followingSwitch: { notices: ProjectSwitch[] } | null = null;

// Projects waits while the Commons holds unsaved labels (lib/commonsUnsaved).
/** GM r24 (c): what the screen says when a flow's chunk didn't load. It has
 * no "Try again" of its own (the button beside it is that), and it shows in
 * the neutral notice, never the danger tint (nothing was lost). */
export const PART_LOAD_LINE = 'Nebula couldn’t open the project because part of the app didn’t load. If it keeps happening, reload the page.';
/** A press whose chunk can't load always answers: the line and a Try again
 * that loads the chunk again and redoes the press. */
export function partFailed(name: string, retryPress: () => unknown): void {
  useProjectStore.setState({ error: PART_LOAD_LINE, errorDetails: null, errorRetry: { action: 'part', name, again: retryPress },
    screen: 'home', loading: false, busy: false });
}
/** Runs `run` with the flows: at once when the chunk is in (so a call the
 * app made synchronously stays so), else once it loads, in order (every cold
 * call waits on the one pending load). */
function runFlows<R>(name: string, run: (flows: ProjectFlows) => R): R | Promise<Awaited<R> | undefined> {
  const flows = flowsNow();
  if (flows) return run(flows);
  return projectFlowsModule.load().then(run, () => { partFailed(name, () => runFlows(name, run)); return undefined; }) as Promise<Awaited<R> | undefined>;
}
/** A flow's subscribe, called before its chunk is in (App renders before it
 * arrives): subscribes once it loads, and says so (`listener`) so the reader
 * looks again. A chunk that never loads leaves it quiet; the press that
 * needs it says the line. */
function subscribeWhenLoaded(subscribe: (flows: ProjectFlows) => () => void, listener: () => void): () => void {
  const flows = flowsNow();
  if (flows) return subscribe(flows);
  let live = true;
  let stop = () => {};
  void projectFlowsModule.load().then((loaded) => { if (live) { stop = subscribe(loaded); listener(); } }, () => undefined);
  return () => { live = false; stop(); };
}
export function subscribeReopenHold(listener: () => void): () => void {
  return subscribeWhenLoaded((flows) => flows.subscribeReopenHold(listener), listener);
}
export function watchOpenHold(): () => void {
  return subscribeWhenLoaded((flows) => flows.watchOpenHold(), () => undefined);
}
/** The stub for a store method that runs in the flows chunk. */
export const via = <K extends keyof ProjectState>(name: K): ProjectState[K] =>
  ((...args: unknown[]) => runFlows(name, (flows) => (flows.actions as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args))) as ProjectState[K];

// <core-accessors>
export const core = {
  get applying() { return applying; },
  set applying(v) { applying = v; },
  get backendParamsCurrent() { return backendParamsCurrent; },
  set backendParamsCurrent(v) { backendParamsCurrent = v; },
  get canvasParamsVersion() { return canvasParamsVersion; },
  set canvasParamsVersion(v) { canvasParamsVersion = v; },
  get canvasTimer() { return canvasTimer; },
  set canvasTimer(v: ReturnType<typeof setTimeout> | null) { canvasTimer = v; },
  get discardOpening() { return discardOpening; },
  set discardOpening(v) { discardOpening = v; },
  get editsDownloaded() { return editsDownloaded; },
  set editsDownloaded(v) { editsDownloaded = v; },
  get followingSwitch() { return followingSwitch; },
  set followingSwitch(v: { notices: ProjectSwitch[] } | null) { followingSwitch = v; },
  get foreignEdits() { return foreignEdits; },
  set foreignEdits(v) { foreignEdits = v; },
  get heldEditsCreate() { return heldEditsCreate; },
  set heldEditsCreate(v: { name?: string; then?: () => Promise<void> } | undefined) { heldEditsCreate = v; },
  get heldEditsReopen() { return heldEditsReopen; },
  set heldEditsReopen(v: string | undefined) { heldEditsReopen = v; },
  get heldFollow() { return heldFollow; },
  set heldFollow(v: { events: GraphSyncEvent[]; stop: () => void } | null) { heldFollow = v; },
  get holdLines() { return holdLines; },
  set holdLines(v: typeof import('../lib/reopenHoldLines') | null) { holdLines = v; },
  get holdWatchers() { return holdWatchers; },
  set holdWatchers(v) { holdWatchers = v; },
  get inFlight() { return inFlight; },
  set inFlight(v: string | null) { inFlight = v; },
  get initializing() { return initializing; },
  set initializing(v: Promise<void> | null) { initializing = v; },
  get keepWindowView() { return keepWindowView; },
  set keepWindowView(v: { renumbered: Record<string, string>; selected: string[]; inspected: string | null;
  studio: KeptStudio } | null) { keepWindowView = v; },
  get keptRecovery() { return keptRecovery; },
  set keptRecovery(v: { fingerprint: string; recoveryId: string } | null) { keptRecovery = v; },
  get keptUpdate() { return keptUpdate; },
  set keptUpdate(v: { version: number | null } | null) { keptUpdate = v; },
  get lastRecoveredCopy() { return lastRecoveredCopy; },
  set lastRecoveredCopy(v: { id: string; name: string; sourceName?: string } | null) { lastRecoveredCopy = v; },
  get lastSaved() { return lastSaved; },
  set lastSaved(v) { lastSaved = v; },
  get lastSeen() { return lastSeen; },
  set lastSeen(v) { lastSeen = v; },
  get leavingFailure() { return leavingFailure; },
  set leavingFailure(v: string | null) { leavingFailure = v; },
  get listingGeneration() { return listingGeneration; },
  set listingGeneration(v) { listingGeneration = v; },
  get listingStale() { return listingStale; },
  set listingStale(v) { listingStale = v; },
  get openHoldBasis() { return openHoldBasis; },
  set openHoldBasis(v: { ambiguities: number; recoveries: number; executing: boolean } | null) { openHoldBasis = v; },
  get openHoldSeq() { return openHoldSeq; },
  set openHoldSeq(v) { openHoldSeq = v; },
  get paramsHandling() { return paramsHandling; },
  set paramsHandling(v) { paramsHandling = v; },
  get paramsVersionChange() { return paramsVersionChange; },
  set paramsVersionChange(v: Promise<void> | null) { paramsVersionChange = v; },
  get pendingRecovery() { return pendingRecovery; },
  set pendingRecovery(v: PendingRecovery | null) { pendingRecovery = v; },
  get personChanges() { return personChanges; },
  set personChanges(v) { personChanges = v; },
  get personInputSaidFor() { return personInputSaidFor; },
  set personInputSaidFor(v: string | null) { personInputSaidFor = v; },
  get personOpenedId() { return personOpenedId; },
  set personOpenedId(v: string | null) { personOpenedId = v; },
  get projectViewport() { return projectViewport; },
  set projectViewport(v: ProjectSnapshot['viewport']) { projectViewport = v; },
  get quietReopenOf() { return quietReopenOf; },
  set quietReopenOf(v: string | null) { quietReopenOf = v; },
  get relistFailures() { return relistFailures; },
  set relistFailures(v) { relistFailures = v; },
  get relistTimer() { return relistTimer; },
  set relistTimer(v: ReturnType<typeof setTimeout> | undefined) { relistTimer = v; },
  get reloadLineCopy() { return reloadLineCopy; },
  set reloadLineCopy(v: { id: string; name: string; sourceName?: string; line: string; stop: () => void } | null) { reloadLineCopy = v; },
  get reloadingForParams() { return reloadingForParams; },
  set reloadingForParams(v) { reloadingForParams = v; },
  get restoredSinceSync() { return restoredSinceSync; },
  set restoredSinceSync(v) { restoredSinceSync = v; },
  get resumePending() { return resumePending; },
  set resumePending(v) { resumePending = v; },
  get saveQueue() { return saveQueue; },
  set saveQueue(v: Promise<unknown>) { saveQueue = v; },
  get savedForeignEdits() { return savedForeignEdits; },
  set savedForeignEdits(v) { savedForeignEdits = v; },
  get savedFromUnder() { return savedFromUnder; },
  set savedFromUnder(v: SavedUnderNote | null) { savedFromUnder = v; },
  get savedPersonChanges() { return savedPersonChanges; },
  set savedPersonChanges(v) { savedPersonChanges = v; },
  get shownReopen() { return shownReopen; },
  set shownReopen(v: { id: string; line: string; place: ReopenHoldPlace; stop: () => void } | null) { shownReopen = v; },
  get sizeNoticeId() { return sizeNoticeId; },
  set sizeNoticeId(v) { sizeNoticeId = v; },
  get sizeOffset() { return sizeOffset; },
  set sizeOffset(v) { sizeOffset = v; },
  get stopHoldWatch() { return stopHoldWatch; },
  set stopHoldWatch(v: (() => void) | null) { stopHoldWatch = v; },
  get syncedRestore() { return syncedRestore; },
  set syncedRestore(v: string | null | undefined) { syncedRestore = v; },
  get syncedSaved() { return syncedSaved; },
  set syncedSaved(v: string | null | undefined) { syncedSaved = v; },
};
// </core-accessors>

export const useProjectStore = create<ProjectState>(holdCommonsExits<ProjectState>(holdProjects, (set, get) => ({
  screen: 'home', initialized: false, loading: true, busy: false,
  projects: [], activeProject: null, trash: [], lastDeleted: null, projectLimit: DEFAULT_PROJECT_LIMIT, catalogRestore: null, canvasNotFiled: null, canvasSaved: null, editsRecoveredAs: null, agentClosedNote: null, keptEdits: null, canvasHeldUnreadable: null, workspaceRevision: '', error: null, errorDetails: null,
  errorRetry: null, saveError: null, saveStatus: 'saved', dirty: false, switchNotice: null, openHold: null, heldReopenLine: null,
  dismissHeldReopenLine: via('dismissHeldReopenLine'),
  unsavedEdits: null, editsSavedAs: null, copyNotice: null, savePaused: null, sizeNotice: null, sizePanelOpen: false,
  openSizePanel: () => { if (get().savePaused) set({ sizePanelOpen: true }); },
  closeSizePanel: () => set({ sizePanelOpen: false }),
  dismissSizeNotice: () => set({ sizeNotice: null }),
  noteLoadedGraph: via('noteLoadedGraph'),
  downloadProjectCopy: via('downloadProjectCopy'),
  dismissSwitchNotice: () => set({ switchNotice: null }),
  switchBack: via('switchBack'),
  pinCover: via('pinCover'),

  initialize: via('initialize'),
  open: via('open'),
  createProject: via('createProject'),
  rename: via('rename'),
  remove: via('remove'),
  restore: via('restore'),
  purge: via('purge'),
  emptyTrash: via('emptyTrash'),
  dismissUndo: () => set({ lastDeleted: null }),
  dismissCanvasSaved: () => set({ canvasSaved: null }),
  dismissEditsRecovered: () => set({ editsRecoveredAs: null }),
  dismissAgentClosedNote: () => set({ agentClosedNote: null }),
  saveKeptEdits: via('saveKeptEdits'),
  discardKeptEdits: via('discardKeptEdits'),
  dismissCatalogRestore: via('dismissCatalogRestore'),
  dismissCanvasHeldUnreadable: via('dismissCanvasHeldUnreadable'),
  dismissCopyNotice: () => set({ copyNotice: null }),
  openCopyNotice: via('openCopyNotice'),
  restoreCopyNotice: via('restoreCopyNotice'),
  goHome: via('goHome'),
  flush: via('flush'),
  retry: () => {
    // A chunk that didn't load (partFailed): load it again and redo the press.
    const failed = get().errorRetry;
    if (failed?.action !== 'part') return via('retry')();
    set({ error: null, errorRetry: null });
    return Promise.resolve(failed.again()).then(() => undefined);
  },
  downloadUnsavedEdits: via('downloadUnsavedEdits'),
  continueWithoutEdits: via('continueWithoutEdits'),
  retrySave: via('retrySave'),
})));


// "This project" for Characters, Moodboards and Styles follows the open
// canvas project (lib/currentProject): this store is its only source.
useProjectStore.subscribe((state) => publishOpenProject(currentProjectOf(state)));

/** The restore notice's id the last graphSync carried (undefined: no sync
 * yet), and whether a new one came since this tab last matched its revision
 * (GM r11 on PR #199, 5). */
let syncedRestore: string | null | undefined;
let restoredSinceSync = false;
/** GM r12 on PR #199, 1, verbatim: the same with edits this tab hasn't
 * saved, beside [Save as a project] (it saves them as "Recovered
 * <name>"; its toast names the project). Closing the tab meanwhile gets the
 * unload warning (the edits are only here). */
/** One source with the kept fallback the home shows while the restore copy's
 * chunk can't load (GM r23, 3). */
export const RESTORED_LIST_UNSAVED = RESTORE_COPY_FALLBACK_KEPT;
/** The id of the last project an agent's write closed to keep the person's
 * canvas in it, as the last graphSync carried it (undefined: no sync yet),
 * and that project when a new one came since this tab last matched its
 * revision: a tab that followed an agent onto the person's protected project
 * goes to Projects home when the agent's next write closes it (review 10 of
 * PR #199, HIGH-2 follow-up), not "another window". */
let syncedSaved: string | null | undefined;
/** What the backend's `personsCanvasSaved` said of that project: who closed
 * it, how, and its name, for GM r14, 3's line. */
export interface SavedUnderNote { id: string; projectId: string; name: string; action: 'clear' | 'replace' | 'change'; agent: string | null }
let savedFromUnder: SavedUnderNote | null = null;
export function agentClosedReloadLine(agent: string | null, action: 'clear' | 'replace' | 'change', name: string): string {
  return `${agentClosedLine(agent, action, name)} ${RELOAD_TO_CONTINUE}`;
}

export type GraphSyncEvent = Extract<Parameters<Parameters<typeof wsClient.subscribeFirst>[0]>[0], { type: 'graphSync' }>;

/**
 * A graphSync, as the project store reads it (or, `synthetic`, the export
 * read after `projectsChanged{catalogRestored}`, which only acts on a
 * restore this tab hasn't seen yet: the sync the backend sends with it is
 * the main path; review 11 of PR #199, HIGH-1).
 */
/** Whether the person is typing in a field of a Studio window (Cinema, the
 * editors, the Character and Moodboard studios, Create, the Commons): a
 * focused text field while the view isn't the canvas. */
export function typingInStudioField(): boolean {
  if (typeof document === 'undefined' || useUIStore.getState().viewMode === 'canvas') return false;
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image'].includes(el.type);
  }
  return false;
}
/** The syncs that came while a Studio field held focus (GM r23, 4), oldest
 * first, replayed when it lets go; null when none waits. The first carries
 * the project switch's notice, so every one is kept, not only the latest. */
let heldFollow: { events: GraphSyncEvent[]; stop: () => void } | null = null;
// GM r108 D1: a "Back to “X”" toast whose way back is now the open project
// has nothing left to offer, however the person got there (its Back, Open
// on an Update, Projects, an agent opening it): it clears at once.
useProjectStore.subscribe((state, previous) => {
  const id = state.activeProject?.id;
  if (!id || id === previous.activeProject?.id) return;
  if (state.switchNotice?.previousProjectId === id) useProjectStore.setState({ switchNotice: null });
});

/** One coordinator stays mounted across Home, Canvas and all studios. */
export function subscribeProjectAutosave(): () => void {
  const graph = useGraphStore.subscribe((state, previous) => {
    if (state.nodes !== previous.nodes || state.edges !== previous.edges || state.runHistory !== previous.runHistory) noteChange();
  });
  const ui = useUIStore.subscribe((state, previous) => {
    // The marks stay until the next setCanvasViewport; a camera cleared by a
    // graph replacement (null) is never the canvas's own.
    const moved = state.canvasViewport !== previous.canvasViewport;
    if (moved && state.canvasViewport && state.canvasViewportInitial) adoptCanvasCamera(previous.canvasViewport);
    else if (moved && state.canvasViewport && state.canvasViewportByCanvas) saveCanvasChange();
    else if (moved || state.createSessionId !== previous.createSessionId) noteChange();
  });
  const drafts = useCreateDraftStore.subscribe(() => markDirty());
  // The person's tab says which project they opened there themselves (GM r13
  // on PR #199, 1): the backend ends the protection of a project filed from
  // the person's waiting canvas on the person's own open, never on a screen
  // the tab reached by following an agent (review 10, HIGH-2).
  wsClient.setViewing(viewingOf(useProjectStore.getState()));
  const viewing = useProjectStore.subscribe((state, previous) => {
    if (state.activeProject?.id !== previous.activeProject?.id) personInputSaidFor = null;
    wsClient.setViewing(viewingOf(state));
  });
  // And their first own edit in a project (GM r13, 1), wherever the tab came
  // from: an agent's edit arriving, a sync or a load is never one.
  const input = onPersonInput(() => {
    const state = useProjectStore.getState();
    const id = state.screen === 'workspace' ? state.activeProject?.id : undefined;
    if (!id || followingSwitch || personInputSaidFor === id) return;
    personInputSaidFor = id;
    wsClient.notePersonAct('personInput', id);
  });
  // GM's line after an import names the project open then.
  useGraphStore.getState().setCanvasProjectName(() => useProjectStore.getState().activeProject?.name ?? null);
  // GM round 23: a replacement with no agent keeps what it cut off as a copy.
  setReplacedCanvasKeeper(() => flowsNow()?.keepReplacedCanvasAsCopy() ?? null);
  // First, so it sees the canvas before the graph store swaps in the new graph.
  const socket = wsClient.subscribeFirst((event) => {
    if (event.type === 'projectsChanged') {
      // An agent's clear or graph load over the canvas waiting to be saved
      // as a project: one Agent log line, no toast (GM's held model).
      const held = event.canvasHeld;
      if (held && typeof window !== 'undefined' && (event.change === 'canvasHeld' || event.change === 'canvasHoldRefused')) {
        // The agent's own row (GM r7): its name and colour, so filtering the
        // log to that agent shows what it tried. Nebula's when unnamed.
        const agent = typeof held.agentId === 'string' && typeof held.agent === 'string'
          ? { id: held.agentId, name: held.agent, color: typeof held.color === 'string' ? held.color : '' } : null;
        const change = event.change;
        withRestoreCopy((copy) => {
          const message = change === 'canvasHeld'
            ? copy.canvasHeldLogLine(held.agent, held.action === 'cleared' || held.action === 'replaced' ? held.action : 'changed',
              typeof held.savedAs === 'string' && held.savedAs ? held.savedAs : null, held.copy === true, held.kept === true)
            : copy.canvasHoldRefusedLogLine(held.agent, held.action === 'clear' || held.action === 'replace' ? held.action : 'change');
          window.dispatchEvent(new CustomEvent('nebula:agent-log-entry', {
            detail: agent ? { source: 'agent', agent, message } : { source: 'system', message } }));
        });
      }
      const state = useProjectStore.getState();
      // The toast's way back shows on the canvas too: a change to that
      // project (renamed, deleted) is listed now, not on the next visit.
      const wayBack = state.switchNotice?.previousProjectId;
      // The open project renamed elsewhere (an agent's rename_project, another
      // tab): the canvas header follows now.
      const openRenamed = event.change === 'renamed' && !!event.projectId && event.projectId === state.activeProject?.id;
      if ((state.screen === 'home' || (wayBack && event.projectId === wayBack) || openRenamed) && !paramsVersionChange) relistNow();
      if (state.screen !== 'home') listingStale = true;
      // Nebula restored its project list while running (review 11 of PR
      // #199, HIGH-1): a restore too. The backend's graphSync with it is the
      // main path; this reads the canvas's export in case that sync is late
      // or lost, and acts only on a restore this tab hasn't seen.
      if (event.change === 'catalogRestored' && getProjectContext() && !isCanvasKept()) {
        void fetchCLIGraph().then((exported) => {
          syncNow({ type: 'graphSync', ...exported } as unknown as GraphSyncEvent, true);
        }).catch(() => undefined);
      }
      return;
    }
    if (event.type === 'socketReconnected') {
      // A reconnect may follow a restore that protected the open project
      // again (review 11 of PR #199, LOW-2): the person's next edit says so.
      personInputSaidFor = null;
      return;
    }
    if (event.type !== 'graphSync') return;
    syncNow(event);
  });
  const outdated = onParamsOutdated((backendVersion) => paramsChangeNow(backendVersion));
  for (const type of ['focus', 'online']) window.addEventListener(type, relistIfStale);
  const beforeUnload = (event: BeforeUnloadEvent) => {
    // GM r20 on PR #199: a kept canvas is only in this tab, so a reload, a
    // tab close or the browser's Back asks first, until kept mode ends.
    if (isCanvasKept()) {
      event.preventDefault();
      // Any non-empty value still asks (browsers show their own text). This
      // literal is the kept guard's own mark, which the build's chunk check
      // finds in the entry chunk (scripts/check-kept-guard-chunk.mjs; review
      // 16 kept-ui NIT-2: a beforeunload elsewhere can't pass for it).
      event.returnValue = KEPT_UNLOAD_MARK;
      return;
    }
    // Review 9, M-3: a scene card's unsaved edits count too (they are
    // saved by their own request, not the project's autosave).
    if (reloadingForParams || (!useProjectStore.getState().dirty && !hasUnsavedSceneEdits())) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  return () => {
    graph(); ui(); drafts(); viewing(); input(); socket(); outdated(); clearTimeout(relistTimer);
    setReplacedCanvasKeeper(null);
    window.removeEventListener('beforeunload', beforeUnload);
    for (const type of ['focus', 'online']) window.removeEventListener(type, relistIfStale);
    cancelPendingSaves();
  };
}

// Back online (round 15): a save the offline gate held goes now.
subscribeBackendConnection(() => {
  const project = useProjectStore.getState();
  if (isBackendOffline() || !project.dirty || project.saveStatus === 'error') return;
  void project.flush().catch(() => { /* Visible retry state. */ });
});
