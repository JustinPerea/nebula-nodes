import { useState, useRef } from 'react';
import { ChevronDown, Plus, Sparkles } from 'lucide-react';
import type { ModelNodeDefinition } from '../../types';
import { ModelPicker } from './ModelPicker';
import { ParamPills } from './ParamPills';

interface CreateComposerProps {
  modelDef: ModelNodeDefinition | null;
  prompt: string;
  params: Record<string, unknown>;
  isExecuting: boolean;
  quantity: number;
  onPromptChange: (value: string) => void;
  onSelectModel: (definitionId: string) => void;
  onParamsChange: (next: Record<string, unknown>) => void;
  onGenerate: () => void;
  onAttach: (files: FileList) => void;
  onQuantityChange: (n: number) => void;
}

export function CreateComposer({
  modelDef, prompt, params, isExecuting, quantity,
  onPromptChange, onSelectModel, onParamsChange, onGenerate, onAttach, onQuantityChange,
}: CreateComposerProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const canGenerate = Boolean(modelDef) && !isExecuting;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div className="create-composer">
      {pickerOpen && (
        <>
          <div className="create-composer__picker-backdrop" onClick={() => setPickerOpen(false)} />
          <ModelPicker value={modelDef?.id ?? null} onSelect={onSelectModel} onClose={() => setPickerOpen(false)} />
        </>
      )}
      <textarea
        ref={promptRef}
        className="create-composer__prompt"
        placeholder="Describe what you want to create…"
        value={prompt}
        rows={1}
        onChange={(e) => { onPromptChange(e.target.value); autoGrow(e.target); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canGenerate) {
            e.preventDefault();
            onGenerate();
          }
        }}
      />
      <div className="create-composer__controls">
        <button type="button" className="create-composer__attach" onClick={() => fileInputRef.current?.click()} title="Attach reference image" aria-label="Attach reference image">
          <Plus size={16} strokeWidth={1.9} aria-hidden="true" />
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple hidden
          onChange={(e) => { if (e.target.files?.length) onAttach(e.target.files); e.target.value = ''; }} />
        <button
          type="button"
          className="create-composer__model"
          onClick={() => setPickerOpen((v) => !v)}
        >
          {modelDef?.displayName ?? 'Select model'}
          <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {modelDef && <ParamPills def={modelDef} params={params} onChange={onParamsChange} />}
        <div className="create-composer__qty" role="group" aria-label="Number of variations">
          <button type="button" onClick={() => onQuantityChange(Math.max(1, quantity - 1))} aria-label="Fewer" disabled={quantity <= 1}>−</button>
          <span>{quantity}</span>
          <button type="button" onClick={() => onQuantityChange(Math.min(4, quantity + 1))} aria-label="More" disabled={quantity >= 4}>+</button>
        </div>
        <button
          type="button"
          className="create-composer__generate"
          disabled={!canGenerate}
          onClick={onGenerate}
        >
          <Sparkles size={16} strokeWidth={1.9} aria-hidden="true" />
          {isExecuting ? 'Generating…' : 'Generate'}
        </button>
      </div>
    </div>
  );
}
