import { useId, useRef, useState, type RefObject } from 'react';
import { ModalPortal } from '../ModalPortal';
import { useCanvasLock } from '../../lib/canvasLock';
import { usePersonLock } from '../../hooks/usePersonLock';
import { PersonLockLine } from '../PersonLock';
import { emptyTrashLine } from '../../lib/projectPurgeCopy';
import { useProjectStore } from '../../store/projectStore';
import { NoticeLeave } from '../../lib/noticeLeave';
import { CHOOSE_A_PROJECT_TO_DELETE } from './restoreCopyCore';
import { ProjectCounts } from './projectFacts';
import { editedDate } from './editedDate';
import { UndoToast } from './UndoToast';
import { useAlertDialog } from './useAlertDialog';
import '../../styles/prompt-dialog.css';
import './KeptDeleteChooser.css';

export const CLOSE_CHOOSER = 'Close';
export const EMPTY_RECENTLY_DELETED = 'Empty Recently deleted';

/**
 * GM r24 (b) on PR #199: the kept save the project limit or the storage cap
 * refused is fixed by deleting, and kept mode locks Projects, so the notice's
 * [Choose a project to delete] opens this: each project with its Delete
 * (it goes to Recently deleted with the app's Undo toast, as Projects
 * home's Delete does, and Projects can restore it), and, when
 * Recently deleted has items, [Empty Recently deleted] (the storage cap's
 * other cure; deleting for good is the person's alone, so it asks first and
 * locks as Projects does). The same modal rules as the Discard confirm
 * (useAlertDialog). Nothing here saves: the person presses [Save as a
 * project] again once there is room.
 */
export function KeptDeleteChooser({ onClose, returnTo }: { onClose: () => void; returnTo?: RefObject<HTMLElement | null> }) {
  const headingId = useId();
  const projects = useProjectStore((state) => state.projects);
  const trash = useProjectStore((state) => state.trash);
  const busy = useProjectStore((state) => state.busy);
  const lastDeleted = useProjectStore((state) => state.lastDeleted);
  const lock = useCanvasLock();
  const purgeLock = usePersonLock('delete projects for good');
  const [armed, setArmed] = useState(false);
  const overlay = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useAlertDialog({ overlay, card, initialFocus: close, onClose, returnTo });
  const held = busy || lock.offline;
  const detail = emptyTrashLine(trash);
  const prompt = `Delete ${trash.length === 1 ? 'this project' : `all ${trash.length} projects`} for good?${detail ? ` ${detail}` : ''}`;
  return (
    <ModalPortal>
      <div ref={overlay} className="prompt-dialog" onMouseDown={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}>
        <div ref={card} className="prompt-dialog__card kept-delete-chooser" role="dialog" aria-modal="true"
          aria-labelledby={headingId} data-kept-delete-chooser="">
          <h2 id={headingId} className="prompt-dialog__heading">{CHOOSE_A_PROJECT_TO_DELETE}</h2>
          <ul className="kept-delete-chooser__list">
            {projects.map((project) => (
              <li key={project.id} className="kept-delete-chooser__row">
                <span className="kept-delete-chooser__facts">
                  <span className="kept-delete-chooser__name">{project.name}</span>
                  <span className="kept-delete-chooser__meta">{editedDate(project.updatedAt)} · <ProjectCounts project={project} /></span>
                </span>
                <span className="prompt-dialog__actions">
                  <button type="button" className="kept-delete-chooser__delete" aria-label={`Delete ${project.name}`} title="Move to Recently deleted" disabled={held}
                    data-kept-delete-project={project.id} onClick={() => void useProjectStore.getState().remove(project.id)}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
          {/* Delete is the app's own: it moves the project to Recently deleted and the same toast
              offers Undo (Projects home's Delete has no confirm either). */}
          <NoticeLeave value={lastDeleted}>{(last, leave) => <UndoToast key={last.id} project={last} busy={busy}
            onUndo={() => void useProjectStore.getState().restore(last.id, 'undo')}
            onDismiss={() => useProjectStore.getState().dismissUndo()} leave={leave} />}</NoticeLeave>
          {trash.length > 0 && (
            <div className="kept-delete-chooser__trash" role="group" aria-label="Recently deleted">
              {armed ? (
                <>
                  <span className="kept-delete-chooser__prompt">{prompt}</span>
                  <PersonLockLine lock={purgeLock} place="control" />
                  <div className="prompt-dialog__actions">
                    <button type="button" autoFocus onClick={() => setArmed(false)}>Cancel</button>
                    <button type="button" className="prompt-dialog__danger" disabled={held} {...purgeLock.control()} data-kept-empty-confirm=""
                      onClick={() => { setArmed(false); if (!purgeLock.locked) void useProjectStore.getState().emptyTrash(); }}>
                      {trash.length === 1 ? 'Delete forever' : 'Delete all'}</button>
                  </div>
                </>
              ) : (
                <div className="prompt-dialog__actions">
                  <button type="button" className="kept-delete-chooser__trigger--danger" disabled={held} {...purgeLock.control()} data-kept-empty=""
                    onClick={() => { if (!purgeLock.locked) setArmed(true); }}>{EMPTY_RECENTLY_DELETED}</button>
                </div>
              )}
            </div>
          )}
          <div className="prompt-dialog__actions">
            <button type="button" ref={close} onClick={onClose} data-kept-delete-close="">{CLOSE_CHOOSER}</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
