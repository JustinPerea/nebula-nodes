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
import type { Moodboard, MoodboardAnalysis, MoodboardImage } from '../../types';
import '../../styles/moodboard-studio.css';

export const NEW_MOODBOARD_SENTINEL = 'new';

type Scope = 'global' | 'project';
type SaveState = 'draft' | 'idle' | 'saving' | 'saved' | 'error';

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
  const enterMoodboardEditor = useUIStore((s) => s.enterMoodboardEditor);
  const exitMoodboardEditor = useUIStore((s) => s.exitMoodboardEditor);

  const [draft, setDraft] = useState<MoodboardDraft>(emptyDraft);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [thumbnail, setThumbnail] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('draft');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const skipNextAutosave = useRef(false);
  const createInFlight = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justCreatedId = useRef<string | null>(null);

  const isDraftId = !moodboardEditorId || moodboardEditorId === NEW_MOODBOARD_SENTINEL;
  const canSave = draft.name.trim().length > 0 && draft.images.length > 0;

  useEffect(() => {
    if (moodboardEditorId && moodboardEditorId === justCreatedId.current) {
      justCreatedId.current = null;
      return;
    }

    let cancelled = false;
    setLoadError(null);
    setSaveError(null);
    setSaveState('idle');

    if (isDraftId) {
      skipNextAutosave.current = true;
      setDraft(emptyDraft());
      setSavedId(null);
      setThumbnail('');
      setSaveState('draft');
      return;
    }

    const targetId = moodboardEditorId as string;
    setLoading(true);
    (async () => {
      try {
        const [globalBoards, projectBoards] = await Promise.all([
          fetchMoodboards('global').catch(() => [] as Moodboard[]),
          fetchMoodboards('project').catch(() => [] as Moodboard[]),
        ]);
        if (cancelled) return;
        const found =
          globalBoards.find((m) => m.id === targetId) ??
          projectBoards.find((m) => m.id === targetId) ??
          null;
        if (!found) {
          skipNextAutosave.current = true;
          setDraft(emptyDraft());
          setSavedId(null);
          setThumbnail('');
          setLoadError('Moodboard not found. Add images to save a new one.');
          setSaveState('draft');
          return;
        }
        skipNextAutosave.current = true;
        setDraft(moodboardToDraft(found));
        setSavedId(found.id);
        setThumbnail(found.thumbnail);
        setSaveState('saved');
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load Moodboard.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moodboardEditorId]);

  const persist = useCallback(async () => {
    if (!canSave) {
      setSaveState('draft');
      return null;
    }
    setSaveState('saving');
    setSaveError(null);

    const body = {
      name: draft.name.trim(),
      images: draft.images,
      notes: draft.notes,
      mode: draft.mode,
      strength: draft.strength,
      analysis: draft.analysis,
      ...(draft.projectId ? { projectId: draft.projectId } : {}),
    };

    try {
      if (savedId) {
        const updated = await updateMoodboard(savedId, body);
        setThumbnail(updated.thumbnail);
        setSaveState('saved');
        return updated.id;
      }
      if (createInFlight.current) return null;
      createInFlight.current = true;
      const created = await createMoodboard(body);
      setSavedId(created.id);
      setThumbnail(created.thumbnail);
      setSaveState('saved');
      if (moodboardEditorId !== created.id) {
        justCreatedId.current = created.id;
        enterMoodboardEditor(created.id);
      }
      return created.id;
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Save failed. Retry?');
      return null;
    } finally {
      createInFlight.current = false;
    }
  }, [canSave, draft, savedId, moodboardEditorId, enterMoodboardEditor]);

  useEffect(() => {
    if (skipNextAutosave.current) {
      skipNextAutosave.current = false;
      return;
    }
    if (!canSave) {
      setSaveState('draft');
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void persist();
    }, 600);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [draft, canSave, persist]);

  const addImageUrls = (urls: string[]) => {
    if (urls.length === 0) return;
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
      .catch((err) => {
        console.error('[moodboard] upload failed:', err);
        setSaveError('Upload failed. Retry.');
      })
      .finally(() => setUploading(false));
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
    const id = savedId ?? await persist();
    if (!id) return;
    setAnalyzing(true);
    setSaveError(null);
    try {
      const updated = await analyzeMoodboard(id);
      skipNextAutosave.current = true;
      setDraft(moodboardToDraft(updated));
      setSavedId(updated.id);
      setThumbnail(updated.thumbnail);
      setSaveState('saved');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Analyze failed.');
      setSaveState('error');
    } finally {
      setAnalyzing(false);
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
      <header className="moodboard-studio-toolbar">
        <button type="button" className="moodboard-studio-toolbar__button" onClick={exitMoodboardEditor}>
          Back
        </button>
        <div className="moodboard-studio-toolbar__title">Moodboard Studio</div>
        <div className="moodboard-studio-toolbar__spacer" />
        <div className={`moodboard-studio-toolbar__state moodboard-studio-toolbar__state--${saveState}`}>
          {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Error' : 'Draft'}
        </div>
        {saveState === 'error' && (
          <button type="button" className="moodboard-studio-toolbar__button" onClick={() => void persist()}>
            Retry
          </button>
        )}
      </header>

      <aside className="moodboard-studio-view__rail">
        <MoodboardRail
          activeId={savedId ?? (isDraftId ? NEW_MOODBOARD_SENTINEL : moodboardEditorId)}
          onSelect={enterMoodboardEditor}
          onNew={() => enterMoodboardEditor(NEW_MOODBOARD_SENTINEL)}
        />
      </aside>

      <main className="moodboard-studio-view__main">
        {loading ? (
          <div className="moodboard-studio-view__loading">Loading Moodboard...</div>
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
                <button type="button" onClick={() => void runAnalyze()} disabled={!canSave || analyzing}>
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
  onSelect,
  onNew,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [scope, setScope] = useState<Scope>('global');
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
      <button type="button" className="moodboard-rail__new" onClick={onNew}>+ New Moodboard</button>
      <div className="moodboard-rail__list">
        {loading && <div className="moodboard-rail__empty">Loading...</div>}
        {error && !loading && <div className="moodboard-rail__empty moodboard-rail__empty--error">{error}</div>}
        {!loading && !error && moodboards.length === 0 && <div className="moodboard-rail__empty">No Moodboards yet.</div>}
        {moodboards.map((m) => (
          <button
            key={m.id}
            type="button"
            className={m.id === activeId ? 'moodboard-rail__item moodboard-rail__item--active' : 'moodboard-rail__item'}
            onClick={() => onSelect(m.id)}
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
