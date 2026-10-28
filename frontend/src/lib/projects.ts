import type { Edge, Node, Viewport } from '@xyflow/react';
import type { NodeData } from '../types';
import type { RunRecord } from './runHistory';
import type { CreateDraft } from '../store/createDraftStore';
import { apiRequest } from './apiRequest';
import { RequestFailedError, type StorageLimit } from './errorCopy';

/** The card's picture (backend services/project_cover.py): a pinned image,
 * the newest made image, or up to four input references for a mosaic. */
export interface ProjectCover {
  source: 'pinned' | 'output' | 'references';
  images: string[];
}
export interface ProjectSummary {
  id: string; name: string; createdAt: string; updatedAt: string;
  lastOpenedAt: string | null; nodeCount: number; edgeCount: number;
  thumbnail: string | null;
  /** Missing from a backend older than covers. */
  cover?: ProjectCover | null;
  /** Who pinned the cover ({kind, name}); none on a pin from before it was recorded (the person's). */
  coverBy?: { kind: string; name: string };
  /** A pin whose image left the project (Q90 a): it no longer counts, and the cover is automatic. */
  coverLostPin?: { url: string; by: { kind: string; name: string } | null };
  /** Set when an agent made the project. */
  createdBy?: { kind: 'agent'; name: string };
}
/** The pictures a card shows: one image, or up to four input references as
 * a mosaic when the project has made nothing yet. */
export function coverImages(project: Pick<ProjectSummary, 'cover' | 'thumbnail'>): { images: string[]; mosaic: boolean } {
  const cover = project.cover;
  if (cover && cover.images.length > 0) {
    const mosaic = cover.source === 'references' && cover.images.length > 1;
    return { images: mosaic ? cover.images.slice(0, 4) : cover.images.slice(0, 1), mosaic };
  }
  return { images: project.thumbnail ? [project.thumbnail] : [], mosaic: false };
}
export interface CoverChoice { url: string; kind: 'output' | 'reference' }
export interface CoverChoices {
  images: CoverChoice[]; pinned: string | null; cover: ProjectCover | null;
  /** Who pinned it: kind "person" is the person; missing from a backend before agents could set covers. */
  pinnedBy?: { kind: string; name: string } | null;
  /** The stored pin while its image is gone ({url, by}); it counts again if the image comes back. */
  lostPin?: { url: string; by: { kind: string; name: string } | null } | null;
}
export interface ProjectSnapshot {
  nodes: Node<NodeData>[]; edges: Edge[]; runHistory: RunRecord[];
  viewport: Viewport | null; createSessionId: string | null;
  createDraft?: CreateDraft | null;
}
export interface SavedProject extends ProjectSummary { snapshot: ProjectSnapshot }
export interface TrashedProject extends ProjectSummary { deletedAt: string; purgeAt: string; deletedBy?: { kind: string; name: string } }
/** Nebula found its project list (catalog.json) damaged and restored it
 * (backend project_store _restore). Listed until the person closes the
 * Projects home notice; the path fields are for the Agent log and agents. */
export interface CatalogRestore {
  id: string; at: string;
  /** 'restored': from the last good copy; 'rebuilt': no good copy, from what the damaged files held. */
  kind: 'restored' | 'rebuilt';
  source: string | null; damagedFile: string | null;
  /** When the copy's catalog was saved (the notice says its age when it decided something). */
  copyAt?: string | null;
  setAside?: string[];
  addedBack: { id: string; name: string; trashed?: boolean }[]; addedBackCount: number;
  /** Found in the damaged file but not put back; `name` when it could be read. */
  notAddedBack?: { id: string; reason: string; name?: string; trashed?: boolean }[];
  notAddedBackCount: number;
  /** What the copy decided (review 1 of PR #199, M1): (a) back to the copy's
   * version (`liveCanvas`: the open project, whose graph came from the live
   * canvas), (b) deleted after the copy and back, (c) restored after the copy
   * and in Recently deleted again. */
  reverted?: { id: string; name: string; trashed?: boolean; liveCanvas?: boolean }[]; revertedCount?: number;
  cameBack?: { id: string; name: string; how?: string }[]; cameBackCount?: number;
  backInTrash?: { id: string; name: string }[]; backInTrashCount?: number;
  /** The live canvas filed as its own project (it wasn't one in the restored
   * list): "<project> (recovered)", numbered, or "Recovered canvas". */
  recoveredCanvas?: SavedCanvas | null;
  /** Other canvases filed as their own projects while the notice showed
   * (GM's answer 1 to review 8: the notice names them, no toast does). */
  alsoFiled?: SavedCanvas[];
  /** Agents' copies of the person's canvas filed while the notice showed:
   * each its own line (GM r11 on PR #199, 4). */
  agentCopies?: SavedCanvas[];
  /** It couldn't be filed: the list is at a limit (review 2 of PR #199, L4). */
  canvasNotFiled?: { reason: 'projects' | 'storage'; current?: boolean } | null;
  /** The open project that didn't come back, and its name when a file had it. */
  openProjectMissing?: string | null; openProjectName?: string | null;
  /** The damaged catalog.json was read to its end (it parsed; only its
   * shape was wrong). False when it was cut or zeroed: what it held past the
   * damage is unknown, so the notice never says nothing was missing. */
  damagedReadWhole?: boolean;
  projectCount?: number; note?: string;
}
/** A canvas saved as its own project (backend main._saved_row): when it
 * was saved (`filedAt`, GM r10's order), and `agentCopy` when it is an
 * agent's copy of the person's canvas (GM r11, 4). */
export interface SavedCanvas {
  id: string; name: string; overSaveLimit?: boolean; filedAt?: string;
  agentCopy?: { agent?: string | null };
}
export interface ProjectList {
  projects: ProjectSummary[]; trash?: TrashedProject[]; activeProjectId: string | null;
  workspaceRevision: string; migratedProjectId?: string | null;
  /** The backend's params version (lib/savedParamsUpgrades.ts). */
  paramsVersion?: number;
  catalogRestore?: CatalogRestore;
  /** A canvas the person had open isn't a project and the list had no room
   * to save it as one: the live canvas (`live`), and `held` more held aside
   * (opening a project holds it first; making one is refused, 413). */
  canvasNotFiled?: { reason: 'projects' | 'storage'; from?: string | null; since?: string | null;
    /** The project limit (the backend's MAX_PROJECTS), for GM's line. */
    projectLimit?: number;
    /** The agents' line (GM's waiting line is the person's). */
    note?: string; live?: boolean; held?: number;
    /** Each canvas that waits (held ones, then the live one), with the name
     * of the project it was when known (review 6 of PR #199, N-2). */
    canvases?: { name?: string | null; agentCopy?: { agent?: string | null } | null }[];
    /** How many projects to delete before every waiting canvas is saved (GM's answer 3). */
    deletes?: number;
    /** Held canvases that couldn't be read (review 6, L-1). */
    heldUnreadable?: { count: number | null; kept?: string[]; at?: string } };
  /** A waiting canvas was saved as its own project, recently: GM's toast.
   * `filed` names every canvas saved with it (review 6, N-2). */
  canvasSaved?: { id: string; name: string; at?: string; overSaveLimit?: boolean;
    /** Filed after a restore notice named a canvas: "Another canvas…" (GM). */
    another?: boolean;
    filedAt?: string; agentCopy?: { agent?: string | null };
    filed?: SavedCanvas[] };
  /** The backend's verdict on a restore from Recently deleted now, held
   * canvases counted (review 6 of PR #199, L-3): absent when it passes. */
  restoreRoom?: { refused: 'projects'; deletes: number | null; heldTakesPlace: boolean; waiting?: number };
  /** canvas-held.json didn't read whole and a held canvas may be lost, for a
   * week (review 6, L-1): the person's line. `count` null: unknown. */
  canvasHeldUnreadable?: { count: number | null; kept?: string[]; at?: string };
  /** How many projects the list may hold (the backend's MAX_PROJECTS). */
  projectLimit?: number;
  /** The switch that lets a restore pass the limit is on (GM r6): Restore in
   * Recently deleted stays enabled at the limit. */
  restoreMayPassTheProjectLimit?: boolean;
}
export interface ProjectActivation {
  project: SavedProject; workspaceRevision: string;
  /** The canvas's revision once it's loaded (round 19): sent back with graph writes. */
  canvasRevision?: string;
  /** Create and open only: the backend's params version (none = 0, a backend from before the gate). */
  paramsVersion?: number;
  /** Open only: what opening changed that the person should know (a folded
   * Krea node's dropped connections, services/retired_nodes.py MERGED). */
  warnings?: string[];
}
export interface ProjectDeletion {
  deletedProjectId: string; trashedProject: TrashedProject;
  activeProjectId: string | null; workspaceRevision: string;
}

/** A refused project call: its heading names the call (GM, error-copy round
 * 2), its reason is the backend's or GM's line for the status, and `status`
 * stays for the store's retry and conflict rules. */
export class ProjectRequestError extends RequestFailedError {
  constructor(reason: string, status: number,
    options: { heading?: string; detail?: unknown; storageFull?: boolean; storageLimit?: StorageLimit | null;
      code?: string | null; overSaveLimit?: boolean; sizeBytes?: number | null } = {}) {
    super(options.heading ?? '', status, { reason, detail: options.detail, storageFull: options.storageFull,
      storageLimit: options.storageLimit, code: options.code, overSaveLimit: options.overSaveLimit,
      sizeBytes: options.sizeBytes });
    this.name = 'ProjectRequestError';
  }
}
const asProjectError = (error: RequestFailedError) => new ProjectRequestError(error.reason, error.status,
  { heading: error.heading, detail: error.detail, storageFull: error.storageFull, storageLimit: error.storageLimit,
    code: error.code, overSaveLimit: error.overSaveLimit, sizeBytes: error.sizeBytes });
async function request<T>(heading: string, path: string, init?: RequestInit): Promise<T> {
  const response = await apiRequest(heading, path, init, { as: asProjectError });
  return response.json() as Promise<T>;
}
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
export const listProjects = () => request<ProjectList>("Couldn't load your projects.", '/api/projects');
export const getProject = (id: string) => request<SavedProject>("Couldn't load the project.", `/api/projects/${encodeURIComponent(id)}`);
export const createProject = (name: string | undefined, workspaceRevision: string) =>
  request<ProjectActivation>("Couldn't create the project.", '/api/projects', json('POST', { name, workspaceRevision }));
export const openProject = (id: string, workspaceRevision: string) =>
  request<ProjectActivation>("Couldn't open the project.", `/api/projects/${encodeURIComponent(id)}/open`, json('POST', { workspaceRevision }));
/** `pending` (round 20, H1): the handoff after an agent's switch names the
 * settings and renames Nebula may not have; Nebula merges exactly those onto
 * its copy of the project left (backend `_save_handoff`). */
export const saveProject = (id: string, snapshot: ProjectSnapshot, workspaceRevision: string,
  pending?: { params: Record<string, Record<string, unknown>>; labels: Record<string, string> }) =>
  request<ProjectActivation>("Couldn't save the project.", `/api/projects/${encodeURIComponent(id)}`, json('PUT', {
    snapshot, workspaceRevision,
    ...(pending && Object.keys(pending.params).length > 0 ? { pendingParams: pending.params } : {}),
    ...(pending && Object.keys(pending.labels).length > 0 ? { pendingLabels: pending.labels } : {}),
  })).then((result) => result.project);
export const renameProject = (id: string, name: string) =>
  request<ProjectActivation>("Couldn't rename the project.", `/api/projects/${encodeURIComponent(id)}`, json('PUT', { name })).then((result) => result.project);
export const deleteProject = (id: string, workspaceRevision: string) =>
  request<ProjectDeletion>("Couldn't delete the project.", `/api/projects/${encodeURIComponent(id)}`, json('DELETE', { workspaceRevision }));
export const restoreProject = (id: string) =>
  request<{ project: ProjectSummary; workspaceRevision: string }>("Couldn't restore the project.", `/api/projects/${encodeURIComponent(id)}/restore`, { method: 'POST' }).then((result) => result.project);
export const purgeTrashedProject = (id: string) =>
  request<{ trash: TrashedProject[] }>("Couldn't delete the project for good.", `/api/projects/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((result) => result.trash);
/** Deletes for good only `ids` (what the list showed), so a project an agent
 * deleted after it loaded stays restorable. */
export const emptyProjectTrash = (ids: string[]) =>
  request<{ trash: TrashedProject[] }>("Couldn't empty Recently deleted.", '/api/projects/trash/empty', json('POST', { ids })).then((result) => result.trash);
/** The person closed the restore notice (×): the backend doesn't list it again. */
/** The person closed the notice that held canvases couldn't be read (GM r9). */
export const dismissCanvasHeldUnreadable = (at: string) =>
  request<{ dismissed: boolean }>("Couldn't close the notice.", '/api/projects/canvas-held-unreadable/dismiss', json('POST', { at }));
export const dismissCatalogRestore = (id: string) =>
  request<{ dismissed: boolean }>("Couldn't close the notice.", '/api/projects/catalog-restore/dismiss', json('POST', { id }));
export const listCoverChoices = (id: string) =>
  request<CoverChoices>("Couldn't load the cover choices.", `/api/projects/${encodeURIComponent(id)}/covers`);
/** Pin one of the project's images as its cover, or `null` for automatic. */
export const pinProjectCover = (id: string, url: string | null) =>
  request<{ project: ProjectSummary }>("Couldn't set the cover.", `/api/projects/${encodeURIComponent(id)}/cover`, json('PUT', { url })).then((result) => result.project);
/** `paramsVersion`: the one-time param upgrades the tab's canvas had when it
 * loaded (lib/savedParamsUpgrades.ts). The backend upgrades the copy from it. */
export const recoverProject = (sourceProjectId: string, snapshot: ProjectSnapshot, recoveryId: string, paramsVersion: number) =>
  request<ProjectActivation>("Couldn't recover the project.", '/api/projects/recover', json('POST', { sourceProjectId, snapshot, recoveryId, paramsVersion })).then((result) => result.project);
