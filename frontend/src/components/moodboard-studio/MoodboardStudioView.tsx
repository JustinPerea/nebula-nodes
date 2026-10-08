import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useUIStore } from '../../store/uiStore';
import {
  analyzeMoodboard,
  createMoodboard,
  fetchMoodboards,
  updateMoodboard,
} from '../../lib/api';
import { apiFetch, backendAssetUrlSync } from '../../lib/backend';
import { WorkspaceHeader } from '../WorkspaceHeader';
import { useAssetStudioDraft } from '../../hooks/useAssetStudioDraft';
import { assetStudioDraftKey, resolveAssetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { NEW_MOODBOARD_SENTINEL } from '../../lib/studioSentinels';
import { getCurrentProject } from '../../lib/currentProject';
import type { AssetScope } from '../../store/uiStore';
import type { Moodboard, MoodboardAnalysis, MoodboardImage } from '../../types';
import '../../styles/moodboard-studio.css';

interface MoodboardDraft {
  name: string;
  images: MoodboardImage[];
  notes: string;
  mode: Moodboard['mode'];
  strength: number;
  analysis: MoodboardAnalysis | null;
  projectId?: string;
}

function emptyDraft(): MoodboardDraft {
  return {
    name: 'Untitled Moodboard',
    images: [],
    notes: '',
    mode: 'look',
    strength: 0.7,
    analysis: null,
  };
}

function moodboardToDraft(m: Moodboard): MoodboardDraft {
  return {
    name: m.name,
    images: [...m.images],
    notes: m.notes,
    mode: m.mode,
    strength: m.strength,
    analysis: m.analysis,
    projectId: m.projectId,
  };
}

function createDraftImage(url: string): MoodboardImage {
  return {
    id: crypto.randomUUID?.() ?? Math.random().toString(16).slice(2),
    url,
    weight: 1,
    notes: '',
    excluded: false,
  };
}

function normalizeAnalysisText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function MoodboardStudioView() {
  const moodboardEditorId = useUIStore((s) => s.moodboardEditorId);
  const moodboardEditorScope = useUIStore((s) => s.moodboardEditorScope);
  const enterMoodboardEditor = useUIStore((s) => s.enterMoodboardEditor);
  const exitMoodboardEditor = useUIStore((s) => s.exitMoodboardEditor);

  const studio = useAssetStudioDraft('moodboard', moodboardEditorScope, moodboardEditorId, emptyDraft);
  const { draft, savedId, thumbnail, saveState, saveError, loadError, loaded,
    dirty, pendingSaveId, pendingAnalysisId, key, revision, epoch, projectId, projectReady, verifyProject, setDraft, initialize, patch } = studio;
  const loading = !loaded;
  const [uploading, setUploading] = useState(false);
  const analyzing = Boolean(pendingAnalysisId);
  const [railScope, setRailScope] = useState<AssetScope>(moodboardEditorScope);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = useCallback(() => {
    const ui = useUIStore.getState();
    return mounted.current && ui.viewMode === 'moodboard-editor' && ui.moodboardEditorId === moodboardEditorId
      && ui.moodboardEditorScope === moodboardEditorScope
      && projectReady && (moodboardEditorScope !== 'project' || useAssetStudioDraftStore.getState().projectId === projectId)
      && useAssetStudioDraftStore.getState().entries[key]?.epoch === epoch;
  }, [moodboardEditorId, moodboardEditorScope, key, epoch, projectReady, projectId]);
  const isDraftId = !moodboardEditorId || moodboardEditorId === NEW_MOODBOARD_SENTINEL;
  const canSave = draft.name.trim().length > 0 && draft.images.length > 0;

  useEffect(() => {
    setUploading(false);
  }, [key, epoch]);

  useEffect(() => {
    if (!projectReady || loaded) return;
    let cancelled = false;
    const current = () => !cancelled && isCurrent()
      && useAssetStudioDraftStore.getState().entries[key]?.revision === revision;
    patch({ loadError: null, saveError: null });
    if (isDraftId) {
      initialize(moodboardEditorScope === 'project' ? { ...emptyDraft(), projectId: projectId! } : emptyDraft());
    } else {
      void Promise.all([fetchMoodboards('global'), fetchMoodboards('project')]).then(([globalBoards, projectBoards]) => {
        if (!current()) return;
        const found = (moodboardEditorScope === 'project' ? projectBoards : globalBoards)
          .find((candidate) => candidate.id === moodboardEditorId && (moodboardEditorScope !== 'project' || candidate.projectId === projectId));
        if (found) {
          setRailScope(found.projectId ? 'project' : 'global');
          initialize(moodboardToDraft(found), found.id, found.thumbnail);
        } else {
          initialize(moodboardEditorScope === 'project' ? { ...emptyDraft(), projectId: projectId! } : emptyDraft(),
            null, '', 'Moodboard not found. Add images to save a new one.');
        }
      }).catch((err) => {
        if (current()) patch({ loadError: err instanceof Error ? err.message : 'Failed to load Moodboard.' });
      });
    }
    return () => { cancelled = true; };
  }, [key, revision, loaded, projectReady, projectId, moodboardEditorId, moodboardEditorScope, initialize, patch, isDraftId, isCurrent]);

  useEffect(() => {
    if (isDraftId && loaded && savedId && isCurrent()) enterMoodboardEditor(savedId, moodboardEditorScope);
  }, [isDraftId, loaded, savedId, isCurrent, moodboardEditorScope, enterMoodboardEditor]);

  const persist = useCallback(async () => {
    if (!isCurrent() || !await verifyProject() || !isCurrent()) return null;
    const store = useAssetStudioDraftStore.getState();
    const current = store.entries[key];
    const currentDraft = current?.draft as MoodboardDraft | undefined;
    if (!currentDraft || !currentDraft.name.trim() || !currentDraft.images.length) return null;
    const attempt = store.beginSave(key);
    if (!attempt) return null;
    try {
      const body = { ...currentDraft, name: currentDraft.name.trim() };
      const result = attempt.entry.savedId
        ? await updateMoodboard(attempt.entry.savedId, body) : await createMoodboard(body);
      if (!store.finishSave(key, attempt.id, attempt.revision, result.id, result.thumbnail)) return null;
      if (!attempt.entry.savedId) {
        const createdScope: AssetScope = result.projectId ? 'project' : 'global';
        const selectedAtCompletion = isCurrent();
        store.copyTo(key, assetStudioDraftKey('moodboard', createdScope, result.id, result.projectId));
        if (selectedAtCompletion) {
          setRailScope(createdScope);
          enterMoodboardEditor(result.id, createdScope);
        }
      }
      return result.id;
    } catch (err) {
      store.failSave(key, attempt.id, err instanceof Error ? err.message : 'Save failed. Retry?');
      return null;
    }
  }, [key, isCurrent, verifyProject, enterMoodboardEditor]);

  useEffect(() => {
    if (!loaded || !dirty || !canSave || pendingSaveId || saveState === 'error') return;
    const timer = window.setTimeout(() => { void persist(); }, 600);
    return () => window.clearTimeout(timer);
  }, [loaded, dirty, canSave, pendingSaveId, saveState, draft, savedId, persist]);

  const addImageUrls = (urls: string[]) => {
    if (urls.length === 0 || !isCurrent()) return;
    setDraft((current) => ({
      ...current,
      analysis: null,
      images: [...current.images, ...urls.map(createDraftImage)],
    }));
  };

  const handleFiles = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const uploads = Array.from(files).map((file) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiFetch('/api/uploads', { method: 'POST', body: fd })
        .then((r) => {
          if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
          return r.json();
        })
        .then((data: { url: string }) => data.url);
    });
    Promise.all(uploads)
      .then((urls) => addImageUrls(urls.filter(Boolean)))
      .catch(() => { if (isCurrent()) patch({ saveError: 'Upload failed. Retry.' }); })
      .finally(() => { if (isCurrent()) setUploading(false); });
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'));
    handleFiles(files);
  };

  const updateImage = (id: string, patch: Partial<MoodboardImage>) => {
    setDraft((current) => ({
      ...current,
      analysis: null,
      images: current.images.map((img) => (img.id === id ? { ...img, ...patch } : img)),
    }));
  };

  const removeImage = (id: string) => {
    setDraft((current) => ({
      ...current,
      analysis: null,
      images: current.images.filter((img) => img.id !== id),
    }));
  };

  const runAnalyze = async () => {
    if (!isCurrent() || !await verifyProject() || !isCurrent()) return;
    const id = dirty || !savedId ? await persist() : savedId;
    if (!id || !mounted.current) return;
    const ui = useUIStore.getState();
    if (ui.viewMode !== 'moodboard-editor') return;
    const store = useAssetStudioDraftStore.getState();
    const targetKey = assetStudioDraftKey('moodboard', ui.moodboardEditorScope, id, store.projectId);
    const selectedKey = resolveAssetStudioDraftKey(store, assetStudioDraftKey('moodboard', ui.moodboardEditorScope, ui.moodboardEditorId, store.projectId));
    if (selectedKey !== targetKey) return;
    const target = store.entries[targetKey];
    if (!target || target.pendingSaveId || target.dirty) {
      store.patch(targetKey, { saveError: 'Settings changed while saving. Analyze again when ready.' });
      return;
    }
    const attempt = store.beginAnalysis(targetKey);
    if (!attempt) return;
    const ownsAnalysis = () => {
      const selected = useUIStore.getState();
      const latest = useAssetStudioDraftStore.getState();
      return mounted.current && selected.viewMode === 'moodboard-editor'
        && resolveAssetStudioDraftKey(latest, assetStudioDraftKey('moodboard', selected.moodboardEditorScope,
          selected.moodboardEditorId, latest.projectId)) === targetKey
        && latest.entries[targetKey]?.revision === attempt.revision
        && latest.entries[targetKey]?.pendingAnalysisId === attempt.id;
    };
    try {
      const updated = await analyzeMoodboard(id);
      if (ownsAnalysis()) store.patch(targetKey, { draft: moodboardToDraft(updated), savedId: updated.id,
        thumbnail: updated.thumbnail, dirty: false, loaded: true, saveState: 'saved' });
    } catch (err) {
      if (ownsAnalysis()) store.patch(targetKey, { saveError: err instanceof Error ? err.message : 'Analyze failed.', saveState: 'error' });
    } finally {
      store.clearAnalysis(targetKey, attempt.id);
    }
  };

  const updateAnalysis = (patch: Partial<MoodboardAnalysis>) => {
    setDraft((current) => {
      const base = current.analysis;
      if (!base) return current;
      return { ...current, analysis: { ...base, ...patch } };
    });
  };

  const previewThumbnail = thumbnail || draft.images.find((img) => !img.excluded)?.url || '';
  const analysis = draft.analysis;

  return (
    <div className="moodboard-studio-view">
      <WorkspaceHeader title="Moodboard" onBack={exitMoodboardEditor} className="moodboard-studio-toolbar">
        <div className={`moodboard-studio-toolbar__state moodboard-studio-toolbar__state--${saveState}`}>
          {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Error' : 'Draft'}
        </div>
        {saveState === 'error' && (
          <button type="button" className="moodboard-studio-toolbar__button" onClick={() => void persist()}>
            Retry
          </button>
        )}
      </WorkspaceHeader>

      <aside className="moodboard-studio-view__rail">
        <MoodboardRail
          key={railScope}
          activeId={savedId ?? (isDraftId ? NEW_MOODBOARD_SENTINEL : moodboardEditorId)}
          initialScope={railScope}
          onSelect={(id, scope) => {
            setRailScope(scope);
            enterMoodboardEditor(id, scope);
          }}
          onNew={(scope) => {
            void (async () => {
              if (!isCurrent()) return;
              const currentProject = scope === 'project' ? await getCurrentProject() : null;
              if (!isCurrent()) return;
              const store = useAssetStudioDraftStore.getState();
              if (currentProject) store.setProjectId(currentProject.id);
              store.reset(assetStudioDraftKey('moodboard', scope, NEW_MOODBOARD_SENTINEL, currentProject?.id), emptyDraft());
              setRailScope(scope);
              enterMoodboardEditor(NEW_MOODBOARD_SENTINEL, scope);
            })().catch((err) => { if (isCurrent()) patch({ saveError: err instanceof Error ? err.message : 'Failed to resolve project.' }); });
          }}
        />
      </aside>

      <main className="moodboard-studio-view__main">
        {loading ? (
          <div className="moodboard-studio-view__loading">
            {loadError ? <div role="alert">{loadError}</div> : 'Loading Moodboard...'}
            {loadError && <button type="button" className="moodboard-studio-toolbar__button"
              onClick={() => { if (!projectReady) void verifyProject(); else patch({ loadError: null, revision: revision + 1 }); }}>Retry loading</button>}
          </div>
        ) : (
          <>
            {loadError && <div className="moodboard-studio__notice moodboard-studio__notice--warn">{loadError}</div>}
            {saveError && <div className="moodboard-studio__notice moodboard-studio__notice--error">{saveError}</div>}

            <section className="moodboard-def">
              <div className="moodboard-def__cover">
                {previewThumbnail ? (
                  <img src={backendAssetUrlSync(previewThumbnail)} alt="" draggable={false} />
                ) : (
                  <span>No images</span>
                )}
              </div>
              <div className="moodboard-def__fields">
                <label className="moodboard-field">
                  <span>Name</span>
                  <input
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <div className="moodboard-def__row">
                  <label className="moodboard-field">
                    <span>Mode</span>
                    <select
                      value={draft.mode}
                      onChange={(event) => setDraft({ ...draft, analysis: null, mode: event.target.value as Moodboard['mode'] })}
                    >
                      <option value="look">Look</option>
                      <option value="world">World</option>
                      <option value="subject">Subject</option>
                    </select>
                  </label>
                  <label className="moodboard-field moodboard-field--grow">
                    <span>Strength {draft.strength.toFixed(2)}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={draft.strength}
                      onChange={(event) => setDraft({ ...draft, analysis: null, strength: Number(event.target.value) })}
                    />
                  </label>
                </div>
                <label className="moodboard-field">
                  <span>Notes</span>
                  <textarea
                    rows={3}
                    value={draft.notes}
                    onChange={(event) => setDraft({ ...draft, analysis: null, notes: event.target.value })}
                    placeholder="What should the board preserve or avoid?"
                  />
                </label>
              </div>
            </section>

            <section
              className={`moodboard-dropzone ${uploading ? 'moodboard-dropzone--busy' : ''}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
            >
              <div className="moodboard-dropzone__head">
                <div>
                  <span className="moodboard-dropzone__label">Images ({draft.images.length})</span>
                  <span className="moodboard-dropzone__hint">Drag images here or add files.</span>
                </div>
                <label className={`moodboard-dropzone__file-wrap ${uploading ? 'moodboard-dropzone__file-wrap--disabled' : ''}`}>
                  <span className="moodboard-dropzone__file-button">
                    {uploading ? 'Uploading' : 'Add Images'}
                  </span>
                  <input
                    className="moodboard-dropzone__file-input"
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={uploading}
                    aria-label="Add Images"
                    onChange={(event) => {
                      handleFiles(event.target.files);
                      event.target.value = '';
                    }}
                  />
                </label>
              </div>
              <div className="moodboard-grid">
                {draft.images.map((img) => (
                  <div key={img.id} className={`moodboard-tile ${img.excluded ? 'moodboard-tile--excluded' : ''}`}>
                    <div className="moodboard-tile__image">
                      <img src={backendAssetUrlSync(img.url)} alt="" draggable={false} />
                      <button type="button" className="moodboard-tile__remove" onClick={() => removeImage(img.id)}>
                        x
                      </button>
                    </div>
                    <div className="moodboard-tile__controls">
                      <label>
                        <span>Weight {img.weight.toFixed(2)}</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={img.weight}
                          onChange={(event) => updateImage(img.id, { weight: Number(event.target.value) })}
                        />
                      </label>
                      <label className="moodboard-tile__toggle">
                        <input
                          type="checkbox"
                          checked={img.excluded}
                          onChange={(event) => updateImage(img.id, { excluded: event.target.checked })}
                        />
                        <span>Exclude</span>
                      </label>
                      <textarea
                        rows={2}
                        value={img.notes}
                        placeholder="Image note"
                        onChange={(event) => updateImage(img.id, { notes: event.target.value })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="moodboard-analysis">
              <div className="moodboard-analysis__head">
                <div>
                  <span className="moodboard-analysis__label">Extraction</span>
                  <span className="moodboard-analysis__hint">
                    Produces the editable creative-direction object used by nodes.
                  </span>
                </div>
                <button type="button" onClick={() => void runAnalyze()} disabled={!canSave || analyzing || Boolean(pendingSaveId)}>
                  {analyzing ? 'Analyzing' : 'Analyze'}
                </button>
              </div>

              {analysis ? (
                <div className="moodboard-analysis__body">
                  <label className="moodboard-field">
                    <span>Style brief</span>
                    <textarea
                      rows={5}
                      value={normalizeAnalysisText(analysis.styleBrief)}
                      onChange={(event) => updateAnalysis({ styleBrief: event.target.value })}
                    />
                  </label>
                  <label className="moodboard-field">
                    <span>Negative prompt</span>
                    <textarea
                      rows={3}
                      value={normalizeAnalysisText(analysis.negativePrompt)}
                      onChange={(event) => updateAnalysis({ negativePrompt: event.target.value })}
                    />
                  </label>
                  {analysis.palette.length > 0 && (
                    <div className="moodboard-palette" aria-label="Extracted palette">
                      {analysis.palette.map((color) => (
                        <span key={color} className="moodboard-palette__swatch" style={{ backgroundColor: color }} title={color} />
                      ))}
                    </div>
                  )}
                  <div className="moodboard-analysis__summary">{analysis.summary}</div>
                </div>
              ) : (
                <div className="moodboard-analysis__empty">
                  Analyze after adding images to extract palette, representative references, a style brief, and provider hints.
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function MoodboardRail({
  activeId,
  initialScope,
  onSelect,
  onNew,
}: {
  activeId: string | null;
  initialScope: AssetScope;
  onSelect: (id: string, scope: AssetScope) => void;
  onNew: (scope: AssetScope) => void;
}) {
  const [scope, setScope] = useState<AssetScope>(initialScope);
  const [moodboards, setMoodboards] = useState<Moodboard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading gate before async fetch; not derived state, does not cascade
    setLoading(true);
    setError(null);
    fetchMoodboards(scope)
      .then((list) => {
        if (!cancelled) setMoodboards(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load.');
          setMoodboards([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, activeId]);

  return (
    <div className="moodboard-rail">
      <div className="moodboard-rail__scope" role="tablist" aria-label="Moodboard scope">
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'project'}
          className={scope === 'project' ? 'moodboard-rail__scope-tab moodboard-rail__scope-tab--active' : 'moodboard-rail__scope-tab'}
          onClick={() => setScope('project')}
        >
          Project
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'global'}
          className={scope === 'global' ? 'moodboard-rail__scope-tab moodboard-rail__scope-tab--active' : 'moodboard-rail__scope-tab'}
          onClick={() => setScope('global')}
        >
          Global
        </button>
      </div>
      <button type="button" className="moodboard-rail__new" onClick={() => onNew(scope)}>+ New Moodboard</button>
      <div className="moodboard-rail__list">
        {loading && <div className="moodboard-rail__empty">Loading...</div>}
        {error && !loading && <div className="moodboard-rail__empty moodboard-rail__empty--error">{error}</div>}
        {!loading && !error && moodboards.length === 0 && <div className="moodboard-rail__empty">No Moodboards yet.</div>}
        {moodboards.map((m) => (
          <button
            key={m.id}
            type="button"
            className={m.id === activeId ? 'moodboard-rail__item moodboard-rail__item--active' : 'moodboard-rail__item'}
            onClick={() => onSelect(m.id, scope)}
          >
            <span className="moodboard-rail__thumb">
              {m.thumbnail ? <img src={backendAssetUrlSync(m.thumbnail)} alt="" draggable={false} /> : <span>MB</span>}
            </span>
            <span className="moodboard-rail__meta">
              <span className="moodboard-rail__name">{m.name || 'Untitled'}</span>
              <span className="moodboard-rail__sub">{m.images.length} images · {m.mode}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
