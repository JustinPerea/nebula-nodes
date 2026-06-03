import { useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import type { ModelNodeDefinition } from '../../types';
import { ModelPicker } from './ModelPicker';
import { ParamPills } from './ParamPills';

interface CreateComposerProps {
  modelDef: ModelNodeDefinition | null;
  prompt: string;
  params: Record<string, unknown>;
  isExecuting: boolean;
  onPromptChange: (value: string) => void;
  onSelectModel: (definitionId: string) => void;
  onParamsChange: (next: Record<string, unknown>) => void;
  onGenerate: () => void;
}

export function CreateComposer({
  modelDef, prompt, params, isExecuting,
  onPromptChange, onSelectModel, onParamsChange, onGenerate,
}: CreateComposerProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const canGenerate = Boolean(modelDef) && !isExecuting;

  return (
    <div className="create-composer">
      {pickerOpen && (
        <>
          <div className="create-composer__picker-backdrop" onClick={() => setPickerOpen(false)} />
          <ModelPicker value={modelDef?.id ?? null} onSelect={onSelectModel} onClose={() => setPickerOpen(false)} />
        </>
      )}
      <textarea
        className="create-composer__prompt"
        placeholder="Describe what you want to create…"
        value={prompt}
        rows={1}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canGenerate) {
            e.preventDefault();
            onGenerate();
          }
        }}
      />
      <div className="create-composer__controls">
        <button
          type="button"
          className="create-composer__model"
          onClick={() => setPickerOpen((v) => !v)}
        >
          {modelDef?.displayName ?? 'Select model'}
          <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {modelDef && <ParamPills def={modelDef} params={params} onChange={onParamsChange} />}
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
