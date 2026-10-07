import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { ChevronDown, Plus, Sparkles, Wand2 } from 'lucide-react';
import type { ModelNodeDefinition } from '../../types';
import { enhancePrompt } from '../../lib/enhancePrompt';
import { ModelPicker } from './ModelPicker';
import { ParamPills } from './ParamPills';
import { useUIStore } from '../../store/uiStore';
import { isKreaGateway, kreaModeForParams } from '../../lib/kreaConnection';
import { isCreateModel } from '../../lib/createModels';

interface CreateComposerProps {
  modelDef: ModelNodeDefinition | null;
  prompt: string;
  params: Record<string, unknown>;
  activeCount: number;
  isLaunching?: boolean;
  referencesBlocked?: boolean;
  referenceStatus?: string;
  maxConcurrent: number;
  quantity: number;
  onPromptChange: (value: string) => void;
  onSelectModel: (definitionId: string) => void;
  onParamsChange: (next: Record<string, unknown>) => void;
  onGenerate: () => void;
  onAttach: (files: FileList) => void;
  onQuantityChange: (n: number) => void;
  onOpenStyles: () => void;
}

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

export function CreateComposer({
  modelDef, prompt, params, activeCount, maxConcurrent, quantity, isLaunching = false,
  referencesBlocked = false, referenceStatus,
  onPromptChange, onSelectModel, onParamsChange, onGenerate, onAttach, onQuantityChange, onOpenStyles,
}: CreateComposerProps) {
  const kreaConnection = useUIStore((s) => s.settingsCache.kreaConnection);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [prevPrompt, setPrevPrompt] = useState<string | null>(null);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const modelSupported = Boolean(modelDef && isCreateModel(modelDef));
  const canGenerate = modelSupported && !isLaunching && !referencesBlocked && activeCount < maxConcurrent;
  const canEnhance = prompt.trim().length > 0 && !enhancing;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const enhanceRequest = useRef(0);
  const currentPrompt = useRef(prompt);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; enhanceRequest.current += 1; };
  }, []);
  useLayoutEffect(() => {
    currentPrompt.current = prompt;
    if (promptRef.current) autoGrow(promptRef.current);
  }, [prompt]);

  const handleEnhance = async () => {
    if (!canEnhance) return;
    setEnhancing(true);
    setEnhanceError(null);
    const original = prompt;
    const request = ++enhanceRequest.current;
    try {
      const enhanced = await enhancePrompt(original);
      if (!mounted.current || request !== enhanceRequest.current || currentPrompt.current !== original) return;
      setPrevPrompt(original);
      onPromptChange(enhanced);
    } catch (err) {
      if (mounted.current && request === enhanceRequest.current && currentPrompt.current === original) {
        setEnhanceError(err instanceof Error ? err.message : 'Enhance failed.');
      }
    } finally {
      if (mounted.current && request === enhanceRequest.current) setEnhancing(false);
    }
  };

  const handleUndoEnhance = () => {
    if (prevPrompt === null) return;
    onPromptChange(prevPrompt);
    setPrevPrompt(null);
  };

  return (
    <div className="create-composer">
      {pickerOpen && (
        <ModelPicker value={modelDef?.id ?? null} onSelect={onSelectModel} onClose={() => setPickerOpen(false)} />
      )}
      {modelDef && !modelSupported && (
        <div className="create-composer__capability-note" role="note">
          This model needs Canvas input controls. Choose another model or return to Canvas.
        </div>
      )}
      {modelDef?.capabilityNote && (
        <div className="create-composer__capability-note" role="note">
          {modelDef.capabilityNote}
        </div>
      )}
      {referenceStatus && <div className="create-composer__capability-note" role="status">{referenceStatus}</div>}
      <textarea
        ref={promptRef}
        className="create-composer__prompt"
        placeholder="Describe what you want to create…"
        value={prompt}
        rows={1}
        onChange={(e) => {
          onPromptChange(e.target.value);
          autoGrow(e.target);
          if (prevPrompt !== null) setPrevPrompt(null);
          if (enhanceError) setEnhanceError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.repeat && canGenerate) {
            e.preventDefault();
            onGenerate();
          }
        }}
      />
      <div className="create-composer__controls">
        <button type="button" className="create-composer__attach" onClick={() => fileInputRef.current?.click()} title="Attach reference image" aria-label="Attach reference image">
          <Plus size={16} strokeWidth={1.9} aria-hidden="true" />
        </button>
        <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
          onChange={(e) => { if (e.target.files?.length) onAttach(e.target.files); e.target.value = ''; }} />
        <button
          type="button"
          className="create-composer__model"
          onClick={() => setPickerOpen((v) => !v)}
        >
          {modelDef?.displayName ?? 'Select model'}
          <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className="create-composer__styles" onClick={onOpenStyles} title="Browse styles">
          Styles
        </button>
        <button
          type="button"
          className="create-composer__enhance"
          onClick={handleEnhance}
          disabled={!canEnhance}
          title="Enhance prompt with AI"
        >
          <Wand2 size={15} strokeWidth={1.8} aria-hidden="true" />
          {enhancing ? 'Enhancing…' : 'Enhance'}
        </button>
        {prevPrompt !== null && !enhanceError && (
          <button type="button" className="create-composer__enhance-undo" onClick={handleUndoEnhance} title="Restore the original prompt">
            Undo
          </button>
        )}
        {enhanceError && (
          <span className="create-composer__enhance-error" role="alert">{enhanceError}</span>
        )}
        {modelDef && <ParamPills def={modelDef} params={params} onChange={onParamsChange} />}
        {isKreaGateway(modelDef ?? undefined) && kreaModeForParams(params) === 'mcp'
          && kreaConnection?.status !== 'connected' && (
            <span className="create-composer__capability-note" role="status">Krea sign-in required.{' '}
              <button type="button" className="create-composer__styles"
                onClick={() => useUIStore.getState().setLeftDock('settings')}>Open connection settings</button>
            </span>
          )}
        <div className="create-composer__qty" role="group" aria-label="Number of variations">
          <button type="button" onClick={() => onQuantityChange(Math.max(1, quantity - 1))} aria-label="Fewer" disabled={quantity <= 1}>−</button>
          <span>{quantity}</span>
          <button type="button" onClick={() => onQuantityChange(Math.min(4, quantity + 1))} aria-label="More" disabled={quantity >= 4}>+</button>
        </div>
        <button
          type="button"
          className="create-composer__generate"
          disabled={!canGenerate}
          onClick={(e) => { if (e.detail <= 1 && canGenerate) onGenerate(); }}
        >
          <Sparkles size={16} strokeWidth={1.9} aria-hidden="true" />
          {activeCount > 0 ? `Generating… (${activeCount})` : 'Generate'}
        </button>
      </div>
    </div>
  );
}
